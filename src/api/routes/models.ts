import _ from 'lodash';

const MODEL_IDS = [
    'deepseek',
    'deepseek-chat',
    'deepseek-think',
    'deepseek-r1',
    'deepseek-search',
    'deepseek-expert',
    'deepseek-expert-r1',
    'deepseek-r1-expert',
    'deepseek-expert-search',
    'deepseek-expert-r1-search',
    'deepseek-r1-expert-search',
    'deepseek-r1-search',
    'deepseek-think-search',
    'deepseek-r1-silent',
    'deepseek-search-silent',
    'deepseek-think-fold',
    'deepseek-r1-fold',
];

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": _.uniq(MODEL_IDS).map((id) => ({
                    id,
                    object: 'model',
                    owned_by: 'deepseek-free-api'
                }))
            };
        }

    }
}
