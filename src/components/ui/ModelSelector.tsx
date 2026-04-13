import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Cloud } from 'lucide-react';
import { buildVisibleModelOptions, getDisplayModelName, type VisibleModelOption } from '../../utils/modelUtils';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

interface ModelSelectorProps {
    currentModel: string;
    onSelectModel: (model: string) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onSelectModel }) => {
    const isLight = useResolvedTheme() === 'light';
    const [isOpen, setIsOpen] = useState(false);
    const [cloudModels, setCloudModels] = useState<VisibleModelOption[]>([]);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const loadData = async () => {
            try {
                const creds = await window.electronAPI?.getStoredCredentials?.();
                setCloudModels(buildVisibleModelOptions(creds));
            } catch (error) {
                console.error('Failed to load models:', error);
            }
        };

        loadData();
    }, [isOpen]);

    const groupedModels = {
        claude: cloudModels.filter(model => model.provider === 'claude'),
        chatgpt: cloudModels.filter(model => model.provider === 'chatgpt'),
    };

    const menuClass = isLight
        ? 'bg-[#F7F8FA]/98 border-black/10 shadow-black/10 text-slate-900'
        : 'bg-[#151821]/97 border-white/10 shadow-black/50 text-white';

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg transition-colors text-xs font-medium text-text-primary max-w-[170px]"
            >
                <span className="truncate">{getDisplayModelName(currentModel)}</span>
                <ChevronDown size={14} className={`shrink-0 text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className={`absolute bottom-full left-0 mb-2 w-72 border rounded-xl shadow-2xl z-[9999] overflow-hidden animated fadeIn backdrop-blur-md ${menuClass}`}>
                    <div className="p-2 max-h-72 overflow-y-auto space-y-2">
                        {cloudModels.length === 0 ? (
                            <div className="text-center py-6 text-text-tertiary">
                                <p className="text-xs mb-2">No Claude or ChatGPT models are available right now.</p>
                                <p className="text-[10px] opacity-70">Start Claude Agent SDK or Codex CLI, then reopen the selector.</p>
                            </div>
                        ) : (
                            <>
                                {groupedModels.claude.length > 0 && (
                                    <ModelGroup
                                        title="Claude"
                                        models={groupedModels.claude}
                                        currentModel={currentModel}
                                        onSelect={(modelId) => {
                                            onSelectModel(modelId);
                                            setIsOpen(false);
                                        }}
                                    />
                                )}
                                {groupedModels.chatgpt.length > 0 && (
                                    <ModelGroup
                                        title="ChatGPT"
                                        models={groupedModels.chatgpt}
                                        currentModel={currentModel}
                                        onSelect={(modelId) => {
                                            onSelectModel(modelId);
                                            setIsOpen(false);
                                        }}
                                    />
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

const ModelGroup = ({
    title,
    models,
    currentModel,
    onSelect,
}: {
    title: string;
    models: VisibleModelOption[];
    currentModel: string;
    onSelect: (modelId: string) => void;
}) => {
    const isLight = useResolvedTheme() === 'light';
    return (
    <div className="space-y-1">
        <div className={`px-2 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{title}</div>
        {models.map((model) => (
            <button
                key={model.id}
                onClick={() => onSelect(model.id)}
                className={`w-full flex items-center justify-between p-2 rounded-lg transition-colors group ${currentModel === model.id ? (isLight ? 'bg-black/[0.07]' : 'bg-white/10') : (isLight ? 'hover:bg-black/[0.04]' : 'hover:bg-white/5')}`}
            >
                <div className="flex items-center gap-3">
                    <div className={`p-1.5 rounded-md ${currentModel === model.id ? 'bg-accent-primary/20 text-accent-primary' : (isLight ? 'bg-white text-slate-500 group-hover:text-slate-900' : 'bg-[#1d2330] text-slate-400 group-hover:text-white')}`}>
                        <Cloud size={14} />
                    </div>
                    <div className="text-left">
                        <div className={`text-xs font-medium truncate max-w-[170px] ${currentModel === model.id ? 'text-accent-primary' : (isLight ? 'text-slate-900' : 'text-white')}`}>{model.name}</div>
                        <div className={`text-[10px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{model.desc}</div>
                    </div>
                </div>
                {currentModel === model.id && <Check size={14} className="text-accent-primary" />}
            </button>
        ))}
    </div>
    );
};
