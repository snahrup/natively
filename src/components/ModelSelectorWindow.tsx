import React, { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { buildVisibleModelOptions, getDisplayModelName, resolvePreferredVisibleModelId, type VisibleModelOption } from '../utils/modelUtils';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

const ModelSelectorWindow = () => {
    const isLight = useResolvedTheme() === 'light';
    const [currentModel, setCurrentModel] = useState<string>('');
    const [availableModels, setAvailableModels] = useState<VisibleModelOption[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(true);

    useEffect(() => {
        const loadModels = async () => {
            try {
                setIsLoading(true);

                const creds = await window.electronAPI?.getStoredCredentials?.();
                const models = buildVisibleModelOptions(creds);
                setAvailableModels(models);

                const config = await window.electronAPI?.getCurrentLlmConfig?.();
                setCurrentModel(resolvePreferredVisibleModelId(config?.model, creds));
            } catch (err) {
                console.error('Failed to load models:', err);
            } finally {
                setIsLoading(false);
            }
        };

        loadModels();
        window.addEventListener('focus', loadModels);

        const unsubscribe = window.electronAPI?.onModelChanged?.((modelId: string) => {
            setCurrentModel(modelId);
        });

        return () => {
            unsubscribe?.();
            window.removeEventListener('focus', loadModels);
        };
    }, []);

    const handleSelect = (modelId: string) => {
        setCurrentModel(modelId);
        window.electronAPI?.setModel(modelId).catch((err: any) => {
            console.error('Failed to set model:', err);
        });
    };

    const panelClass = isLight
        ? 'bg-white text-slate-950 border-slate-200 shadow-[0_24px_80px_rgba(15,23,42,0.22)]'
        : 'bg-[#10131A] text-white border-white/20 shadow-[0_24px_90px_rgba(0,0,0,0.78)]';

    const providerLabelClass = isLight ? 'text-slate-500' : 'text-slate-400';

    const groupedModels = {
        claude: availableModels.filter(model => model.provider === 'claude'),
        chatgpt: availableModels.filter(model => model.provider === 'chatgpt'),
    };

    return (
        <div className="w-fit h-fit bg-transparent flex flex-col p-2">
            <div className={`w-[312px] max-h-[392px] border rounded-xl overflow-hidden p-2 flex flex-col animate-scale-in origin-top-left ${panelClass}`}>
                {isLoading ? (
                    <div className={`flex items-center justify-center py-6 ${providerLabelClass}`}>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span className="text-xs">Loading models...</span>
                    </div>
                ) : availableModels.length === 0 ? (
                    <div className={`px-4 py-6 text-center text-xs ${providerLabelClass}`}>
                        No Claude or ChatGPT models are ready.
                        <br />
                        Start Claude Agent SDK or Codex CLI, then try again.
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-2">
                        {groupedModels.claude.length > 0 && (
                            <ModelGroup
                                title="Claude"
                                models={groupedModels.claude}
                                currentModel={currentModel}
                                isLight={isLight}
                                onSelect={handleSelect}
                            />
                        )}
                        {groupedModels.chatgpt.length > 0 && (
                            <ModelGroup
                                title="ChatGPT"
                                models={groupedModels.chatgpt}
                                currentModel={currentModel}
                                isLight={isLight}
                                onSelect={handleSelect}
                            />
                        )}
                        {availableModels.every(model => model.id !== currentModel) && currentModel && (
                            <div className={`px-2 pt-1 text-[10px] ${providerLabelClass}`}>
                                Current: {getDisplayModelName(currentModel)}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

const ModelGroup = ({
    title,
    models,
    currentModel,
    isLight,
    onSelect,
}: {
    title: string;
    models: VisibleModelOption[];
    currentModel: string;
    isLight: boolean;
    onSelect: (modelId: string) => void;
}) => (
    <div className="flex flex-col gap-1">
        <div className={`px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
            {title}
        </div>
        {models.map((model) => {
            const isSelected = currentModel === model.id;
            return (
                <button
                    key={model.id}
                    onClick={() => onSelect(model.id)}
                    className={[
                        'w-full text-left px-3 py-2.5 flex items-center justify-between rounded-lg transition-colors duration-200',
                        isSelected
                            ? (isLight ? 'bg-black/[0.07] text-slate-900' : 'bg-white/10 text-white')
                            : (isLight ? 'text-slate-600 hover:bg-black/[0.04] hover:text-slate-900' : 'text-slate-300 hover:bg-white/5 hover:text-white'),
                    ].join(' ')}
                >
                    <div className="min-w-0">
                        <div className="text-[12px] font-medium truncate">{model.name}</div>
                        <div className={`text-[10px] truncate ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{model.desc}</div>
                    </div>
                    {isSelected && <Check className={`w-3.5 h-3.5 shrink-0 ml-2 ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`} />}
                </button>
            );
        })}
    </div>
);

export default ModelSelectorWindow;
