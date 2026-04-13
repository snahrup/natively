import React from 'react';
import { Cpu, Download, Globe, Shield } from 'lucide-react';

interface AboutSectionProps {}

const openExternal = (url: string) => {
    if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(url);
        return;
    }

    window.open(url, '_blank');
};

export const AboutSection: React.FC<AboutSectionProps> = () => {
    return (
        <div className="space-y-6 animated fadeIn pb-10">
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">About Natively</h3>
                <p className="text-sm text-text-secondary">
                    A local-first proactive meeting and workflow companion designed to stay useful, fast, and out of the way.
                </p>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Core Principles</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    <div className="p-4 border-b border-border-subtle bg-bg-card/50 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                            <Shield size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary mb-1">Private by Default</h5>
                            <p className="text-xs text-text-secondary leading-relaxed">
                                Meeting context, screenshots, transcripts, and memory stay on-device unless you explicitly route them through an external provider.
                            </p>
                        </div>
                    </div>

                    <div className="p-4 border-b border-border-subtle bg-bg-card/50 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                            <Cpu size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary mb-1">Context-Aware Assistance</h5>
                            <p className="text-xs text-text-secondary leading-relaxed">
                                Natively combines live screen context, audio, memory, and direct chat to keep answers accurate, timely, and easy to use in the moment.
                            </p>
                        </div>
                    </div>

                    <div className="p-4 bg-bg-card/50 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                            <Download size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary mb-1">Installed Desktop App</h5>
                            <p className="text-xs text-text-secondary leading-relaxed">
                                Built and packaged as a real Electron desktop application with local assets, native modules, and on-device memory.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Resources</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <button
                        onClick={() => openExternal('https://natively.software')}
                        className="bg-bg-item-surface border border-border-subtle rounded-xl p-5 transition-all group flex items-center gap-4 h-full hover:bg-white/10 text-left"
                    >
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
                            <Globe size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary">Website</h5>
                            <p className="text-xs text-text-secondary mt-0.5">Open the main product site.</p>
                        </div>
                    </button>

                    <button
                        onClick={() => openExternal('https://natively.software/downloads')}
                        className="bg-bg-item-surface border border-border-subtle rounded-xl p-5 transition-all group flex items-center gap-4 h-full hover:bg-white/10 text-left"
                    >
                        <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 shrink-0">
                            <Download size={20} />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary">Downloads</h5>
                            <p className="text-xs text-text-secondary mt-0.5">Open the latest desktop installers and release notes.</p>
                        </div>
                    </button>
                </div>
            </div>

            <div className="pt-4 border-t border-border-subtle">
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-3">Core Technology</h4>
                <div className="flex flex-wrap gap-2">
                    {['Claude CLI', 'Codex CLI', 'Electron', 'React', 'SQLite', 'TypeScript', 'Sharp'].map((tech) => (
                        <span
                            key={tech}
                            className="px-2.5 py-1 rounded-md bg-bg-input border border-border-subtle text-[11px] font-medium text-text-secondary"
                        >
                            {tech}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
};
