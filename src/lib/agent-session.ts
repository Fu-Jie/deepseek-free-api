import _ from 'lodash';

import Request from '@/lib/request/Request.ts';

export function stableStringify(value: any): string {
    if (_.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (_.isObject(value)) {
        const objectValue = value as Record<string, any>;
        return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function hashString(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

export function getHeader(request: Request, name: string) {
    return _.get(request.headers, name.toLowerCase()) || _.get(request.headers, name);
}

export function getClientIdentity(request: Request) {
    const explicitClientId = getHeader(request, 'x-client-id') || getHeader(request, 'x-newapi-user') || getHeader(request, 'x-newapi-token');
    const authorization = String(getHeader(request, 'authorization') || '');
    return String(explicitClientId || `auth_${hashString(authorization)}`);
}

export function getExplicitSessionId(request: Request) {
    const sessionId = getHeader(request, 'x-session-id') || getHeader(request, 'x-newapi-session');
    return sessionId ? String(sessionId) : '';
}

export function tokenFingerprint(token?: string | null) {
    const rawToken = String(token || '').replace(/^Bearer\s+/i, '').trim();
    return rawToken ? hashString(rawToken).slice(0, 12) : 'none';
}

export function buildSessionPrefix(request: Request, endpoint: string, model: string, token?: string | null) {
    const clientId = getClientIdentity(request);
    return `${endpoint}:${clientId}:acct_${tokenFingerprint(token)}:${model}`;
}

export function selectTokenForSession(tokens: any[], seed: string) {
    const availableTokens = (_.isArray(tokens) ? tokens : [])
        .filter(_.isString)
        .map((token) => token.trim())
        .filter(Boolean);

    if (availableTokens.length === 0) return '';
    if (availableTokens.length === 1) return availableTokens[0];

    const index = parseInt(hashString(seed).slice(0, 8), 16) % availableTokens.length;
    return availableTokens[index];
}