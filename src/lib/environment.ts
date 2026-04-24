import path from 'path';

import fs from 'fs-extra';
import minimist from 'minimist';
import _ from 'lodash';

function parseEnvValue(value: string) {
    const trimmed = value.trim();
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
        const unquoted = trimmed.slice(1, -1);
        if (quote === '"')
            return unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
        return unquoted;
    }
    return trimmed;
}

function loadEnvFile(filePath: string) {
    if (!fs.pathExistsSync(filePath)) return;
    const content = fs.readFileSync(filePath).toString();
    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) return;
        const key = trimmed.slice(0, separatorIndex).trim();
        if (!key || process.env[key] !== undefined) return;
        process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1));
    });
}

loadEnvFile(path.join(path.resolve(), '.env'));

const cmdArgs = minimist(process.argv.slice(2));  //获取命令行参数
const envVars = process.env;  //获取环境变量

class Environment {

    /** 命令行参数 */
    cmdArgs: any;
    /** 环境变量 */
    envVars: any;
    /** 环境名称 */
    env?: string;
    /** 服务名称 */
    name?: string;
    /** 服务地址 */
    host?: string;
    /** 服务端口 */
    port?: number;
    /** 包参数 */
    package: any;

    constructor(options: any = {}) {
        const { cmdArgs, envVars, package: _package } = options;
        this.cmdArgs = cmdArgs;
        this.envVars = envVars;
        this.env = _.defaultTo(cmdArgs.env || envVars.SERVER_ENV, 'dev');
        this.name = cmdArgs.name || envVars.SERVER_NAME || undefined;
        this.host = cmdArgs.host || envVars.SERVER_HOST || undefined;
        this.port = Number(cmdArgs.port || envVars.SERVER_PORT) ? Number(cmdArgs.port || envVars.SERVER_PORT) : undefined;
        this.package = _package;
    }

}

export default new Environment({
    cmdArgs,
    envVars,
    package: JSON.parse(fs.readFileSync(path.join(path.resolve(), "package.json")).toString())
});
