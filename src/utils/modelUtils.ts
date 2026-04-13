export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

type ProviderKey = 'claude' | 'chatgpt';

export interface VisibleModelOption {
    id: string;
    name: string;
    desc: string;
    provider: ProviderKey;
}

export const STANDARD_CLOUD_MODELS: Record<string, {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
}> = {
    claude: {
        hasKeyCheck: (creds) => !!creds?.hasClaudeMax,
        ids: ['claude-sonnet-4-6', 'claude-opus-4-6'],
        names: ['Claude Sonnet', 'Claude Opus'],
        descs: ['Balanced reasoning', 'Highest quality']
    },
    openai: {
        hasKeyCheck: (creds) => !!creds?.hasCodex,
        ids: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'],
        names: ['ChatGPT 5.4', 'ChatGPT 5.4 Mini', 'ChatGPT 5.3 Codex', 'ChatGPT 5.3 Codex Spark', 'ChatGPT 5.2'],
        descs: ['Flagship reasoning', 'Faster everyday work', 'Code-heavy reasoning', 'Fast code iteration', 'Stable fallback']
    },
};

const CHATGPT_MODELS: VisibleModelOption[] = [
    { id: 'gpt-5.4', name: '5.4', desc: 'Flagship reasoning', provider: 'chatgpt' },
    { id: 'gpt-5.4-mini', name: '5.4 Mini', desc: 'Faster everyday work', provider: 'chatgpt' },
    { id: 'gpt-5.3-codex', name: '5.3 Codex', desc: 'Code-heavy reasoning', provider: 'chatgpt' },
    { id: 'gpt-5.3-codex-spark', name: '5.3 Codex Spark', desc: 'Fast code iteration', provider: 'chatgpt' },
    { id: 'gpt-5.2', name: '5.2', desc: 'Stable fallback', provider: 'chatgpt' },
];

const CLAUDE_MODELS: VisibleModelOption[] = [
    { id: 'claude-sonnet-4-6', name: 'Sonnet', desc: 'Balanced reasoning', provider: 'claude' },
    { id: 'claude-opus-4-6', name: 'Opus', desc: 'Highest quality', provider: 'claude' },
];

const DISPLAY_NAME_BY_ID: Record<string, string> = {
    'claude-sonnet-4-6': 'Claude Sonnet',
    'claude-opus-4-6': 'Claude Opus',
    'gpt-5.4': 'ChatGPT 5.4',
    'gpt-5.4-mini': 'ChatGPT 5.4 Mini',
    'gpt-5.3-codex': 'ChatGPT 5.3 Codex',
    'gpt-5.3-codex-spark': 'ChatGPT 5.3 Codex Spark',
    'gpt-5.2': 'ChatGPT 5.2',
    'natively': 'Natively',
};

const MODEL_ID_ALIASES: Record<string, string> = {
    'claude': 'claude-sonnet-4-6',
    'claude-max': 'claude-sonnet-4-6',
    'claude-max-sonnet': 'claude-sonnet-4-6',
    'claude-max-sonnet-4-6': 'claude-sonnet-4-6',
    'claude-max-opus': 'claude-opus-4-6',
    'claude-max-opus-4-6': 'claude-opus-4-6',
    'codex': 'gpt-5.4',
    'codex-gpt-5.4': 'gpt-5.4',
    'codex-gpt-5.4-mini': 'gpt-5.4-mini',
    'codex-gpt-5.3-codex': 'gpt-5.3-codex',
    'codex-gpt-5.3-codex-spark': 'gpt-5.3-codex-spark',
    'codex-gpt-5.2': 'gpt-5.2',
};

export const REASONING_EFFORT_OPTIONS: Array<{ id: ReasoningEffort; label: string; desc: string }> = [
    { id: 'low', label: 'Low', desc: 'Fastest' },
    { id: 'medium', label: 'Medium', desc: 'Balanced' },
    { id: 'high', label: 'High', desc: 'Deeper reasoning' },
    { id: 'xhigh', label: 'Extra High', desc: 'Maximum depth' },
];

export const buildVisibleModelOptions = (creds: any): VisibleModelOption[] => {
    const models: VisibleModelOption[] = [];

    if (creds?.hasClaudeMax) {
        models.push(...CLAUDE_MODELS);
    }

    if (creds?.hasCodex) {
        models.push(...CHATGPT_MODELS);
    }

    return models;
};

export const modelSupportsReasoningEffort = (modelId: string): boolean => {
    if (!modelId) return false;
    const normalized = normalizeRequestedModelId(modelId).toLowerCase();
    return normalized.startsWith('gpt-5') || /^o[1345](?:$|[-.])/.test(normalized);
};

export const getReasoningEffortLabel = (effort: ReasoningEffort): string => {
    return REASONING_EFFORT_OPTIONS.find(option => option.id === effort)?.label || 'Extra High';
};

export const getDisplayModelName = (id: string): string => {
    if (!id) return '';
    if (id.startsWith('ollama-')) return id.replace('ollama-', '');

    const normalizedId = normalizeRequestedModelId(id);
    if (DISPLAY_NAME_BY_ID[normalizedId]) {
        return DISPLAY_NAME_BY_ID[normalizedId];
    }

    if (id === 'gemini-3.1-flash-lite-preview') return 'Gemini 3.1 Flash';
    if (id === 'gemini-3.1-pro-preview') return 'Gemini 3.1 Pro';
    if (id === 'llama-3.3-70b-versatile') return 'Groq Llama 3.3';

    return prettifyModelId(normalizedId || id);
};

export const normalizeRequestedModelId = (id?: string): string => {
    if (!id) return '';
    return MODEL_ID_ALIASES[id] || id;
};

const getLegacyRequestedModelFallbacks = (requestedId?: string): string[] => {
    if (!requestedId) return [];

    switch (requestedId) {
        case 'claude':
        case 'claude-max':
        case 'claude-max-sonnet':
        case 'claude-max-sonnet-4-6':
            return ['claude-sonnet-4-6'];
        case 'claude-max-opus':
        case 'claude-max-opus-4-6':
            return ['claude-opus-4-6'];
        case 'codex':
        case 'codex-gpt-5.4':
            return ['gpt-5.4'];
        case 'codex-gpt-5.4-mini':
            return ['gpt-5.4-mini'];
        case 'codex-gpt-5.3-codex':
            return ['gpt-5.3-codex'];
        case 'codex-gpt-5.3-codex-spark':
            return ['gpt-5.3-codex-spark'];
        case 'codex-gpt-5.2':
            return ['gpt-5.2'];
        default:
            return [];
    }
};

export const resolvePreferredVisibleModelId = (requestedId: string | undefined, creds: any): string => {
    const models = buildVisibleModelOptions(creds);
    const normalizedRequestedId = normalizeRequestedModelId(requestedId);

    if (normalizedRequestedId && models.some(model => model.id === normalizedRequestedId)) {
        return normalizedRequestedId;
    }

    const legacyFallback = getLegacyRequestedModelFallbacks(requestedId)
        .find(candidate => models.some(model => model.id === candidate));
    if (legacyFallback) {
        return legacyFallback;
    }

    if (models.length > 0) {
        return models[0].id;
    }

    return normalizedRequestedId || requestedId || '';
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};
