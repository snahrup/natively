/**
 * DeepgramStreamingSTT - WebSocket-based streaming Speech-to-Text using Deepgram Nova-3
 *
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Sends raw PCM (linear16, 16-bit LE) over WebSocket — NO WAV header.
 * Receives interim and final transcription results in real time.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 5000;
// Receive-side liveness: if an OPEN socket produces no message/pong for this
// long, it is half-open (e.g. WiFi drop — OS keeps the TCP socket "open" for
// minutes while every send is silently lost). Terminate to force reconnect.
const LIVENESS_TIMEOUT_MS = 15000;
// ~30-75s of disconnect audio (chunks arrive every ~20-50ms)
const MAX_BUFFER_CHUNKS = 1500;

export class DeepgramStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode: string | null = 'en'; // null = auto-detect via detect_language=true

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];
    private isConnecting = false;
    private lastLivenessAt = 0;
    private lastConnectAttemptAt = 0;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    // =========================================================================
    // Configuration (match GoogleSTT / RestSTT interface)
    // =========================================================================

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        console.log(`[DeepgramStreaming] Sample rate set to ${rate}`);

        if (this.isActive) {
            console.log('[DeepgramStreaming] Sample rate changed while active. Restarting...');
            const savedBuffer = [...this.buffer];
            this.stop();
            this.start();
            if (savedBuffer.length > 0) {
                this.buffer = [...savedBuffer, ...this.buffer];
            }
        }
    }

    public setAudioChannelCount(count: number): void {
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
    }

    /** Set recognition language using ISO-639-1 code, or 'auto' for detect_language mode */
    public setRecognitionLanguage(key: string): void {
        const restartIfActive = () => {
            if (this.isActive) {
                console.log('[DeepgramStreaming] Language changed while active. Restarting...');
                const savedBuffer = [...this.buffer];
                this.stop();
                this.start();
                if (savedBuffer.length > 0) {
                    this.buffer = [...savedBuffer, ...this.buffer];
                }
            }
        };

        if (key === 'auto') {
            this.languageCode = null;
            console.log('[DeepgramStreaming] Language set to auto-detect (detect_language=true)');
            restartIfActive();
            return;
        }

        const config = RECOGNITION_LANGUAGES[key];
        if (config) {
            this.languageCode = config.iso639;
            console.log(`[DeepgramStreaming] Language set to ${this.languageCode}`);
            restartIfActive();
        }
    }

    /** No-op — no Google credentials needed */
    public setCredentials(_path: string): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        if (this.isActive) return;
        // Mark active immediately so write() buffers chunks
        // instead of dropping them during WebSocket handshake (~500ms).
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        this.clearTimers();

        if (this.ws) {
            try {
                // Send Deepgram's graceful close message
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
                }
            } catch {
                // Ignore send errors during shutdown
            }
            this.ws.close();
            this.ws = null;
        }

        this.isActive = false;
        this.isConnecting = false;
        this.buffer = [];
        console.log('[DeepgramStreaming] Stopped');
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.buffer.push(chunk);
            if (this.buffer.length > MAX_BUFFER_CHUNKS) this.buffer.shift(); // Cap buffer size

            // Lazy connect, throttled: without the time guard this fires per
            // audio chunk (up to ~50/sec) whenever no reconnect timer is set.
            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer &&
                Date.now() - this.lastConnectAttemptAt > RECONNECT_BASE_DELAY_MS) {
                console.log('[DeepgramStreaming] WS not ready. Lazy connecting on new audio...');
                this.connect();
            }
            return;
        }

        this.ws.send(chunk);
    }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;
        this.lastConnectAttemptAt = Date.now();

        const langParam = this.languageCode === null
            ? '&detect_language=true'
            : `&language=${this.languageCode}`;

        const url =
            `wss://api.deepgram.com/v1/listen` +
            `?model=nova-3` +
            `&encoding=linear16` +
            `&sample_rate=${this.sampleRate}` +
            `&channels=${this.numChannels}` +
            langParam +
            `&punctuate=true` +
            `&smart_format=true` +
            `&diarize=true` +
            `&endpointing=700` +
            `&utterance_end_ms=1000` +
            `&interim_results=true` +
            `&keepalive=true`;

        console.log(`[DeepgramStreaming] Connecting (rate=${this.sampleRate}, ch=${this.numChannels})...`);

        this.ws = new WebSocket(url, {
            headers: {
                Authorization: `Token ${this.apiKey}`,
            },
        });
        // Identity capture: recovery restarts can replace this.ws while this
        // socket's handshake/close events are still in flight. Handlers must
        // ignore events from a socket that is no longer the current one.
        const socket = this.ws;

        this.ws.on('open', () => {
            // Guard: stop() may have run mid-handshake, or a newer socket may
            // have replaced this one. Without this, a late open latches
            // isActive=true with shouldReconnect=false and the next start()
            // becomes a silent no-op.
            if (this.ws !== socket || !this.shouldReconnect) {
                try { socket.close(); } catch { /* ignore */ }
                if (this.ws === socket) {
                    this.ws = null;
                    this.isConnecting = false;
                }
                return;
            }
            this.isActive = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.lastLivenessAt = Date.now();
            console.log('[DeepgramStreaming] Connected');

            // Send buffered audio
            while (this.buffer.length > 0) {
                const chunk = this.buffer.shift();
                if (chunk && this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(chunk);
                }
            }

            // Start keep-alive pings
            this.startKeepAlive();
        });

        this.ws.on('pong', () => {
            this.lastLivenessAt = Date.now();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            this.lastLivenessAt = Date.now();
            try {
                const msg = JSON.parse(data.toString());

                // Deepgram response structure:
                // { type: "Results", channel: { alternatives: [{ transcript, confidence }] }, is_final }
                if (msg.type !== 'Results') return;

                const alternative = msg.channel?.alternatives?.[0];
                const transcript = alternative?.transcript;
                if (!transcript) return;
                const diarizedSpeaker = dominantDeepgramSpeaker(alternative?.words);

                this.emit('transcript', {
                    text: transcript,
                    isFinal: msg.is_final ?? false,
                    confidence: alternative?.confidence ?? 1.0,
                    diarizedSpeaker,
                });
            } catch (err) {
                console.error('[DeepgramStreaming] Parse error:', err);
            }
        });

        this.ws.on('error', (err: Error) => {
            console.error('[DeepgramStreaming] WebSocket error:', err.message);
            this.emit('error', err);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
            // Stale event from a socket that was already replaced (recovery
            // restart) — don't clear the NEW socket's keepalive or reconnect.
            if (this.ws !== socket) return;

            // Do not force isActive=false; let write() trigger reconnect if isActive is still true
            this.isConnecting = false;
            this.clearKeepAlive();
            console.log(`[DeepgramStreaming] Closed (code=${code}, reason=${reason.toString()})`);

            // Auto-reconnect on unexpected close (excluding silence timeout 1000)
            if (this.shouldReconnect && code !== 1000) {
                this.scheduleReconnect();
            }
        });
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;

        // Never give up while a session is running: a meeting can outlive any
        // outage. After the exponential ramp, keep retrying at the max interval.
        // Surface degradation once so the audio-error pipeline can show it.
        if (this.reconnectAttempts === RECONNECT_MAX_ATTEMPTS) {
            console.error(`[DeepgramStreaming] ${RECONNECT_MAX_ATTEMPTS} reconnect attempts failed — continuing to retry every ${RECONNECT_MAX_DELAY_MS / 1000}s`);
            this.emit('error', new Error('DeepgramStreamingSTT: repeated reconnect failures — transcription degraded, still retrying'));
        }

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        // Cap the counter so Math.pow stays bounded; delay is already at max.
        this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, RECONNECT_MAX_ATTEMPTS + 1);

        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.lastLivenessAt = Date.now();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState !== WebSocket.OPEN) return;

            // Liveness watchdog: a healthy server answers pings (protocol pong)
            // even when nobody is speaking. No traffic at all means the socket
            // is half-open — terminate so close/reconnect runs NOW instead of
            // after the OS retransmission timeout (1-2+ minutes of lost audio).
            if (Date.now() - this.lastLivenessAt > LIVENESS_TIMEOUT_MS) {
                console.warn(`[DeepgramStreaming] No server traffic for ${LIVENESS_TIMEOUT_MS / 1000}s — terminating half-open socket`);
                try { this.ws.terminate(); } catch { /* close handler reconnects */ }
                return;
            }

            try {
                // KeepAlive JSON prevents Deepgram idle timeout; protocol ping
                // forces a pong so liveness is observable during silence.
                this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
                this.ws.ping();
            } catch {
                // Ignore errors
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}

function dominantDeepgramSpeaker(words: any[] | undefined): string | null {
    if (!Array.isArray(words) || words.length === 0) return null;

    const counts = new Map<string, number>();
    for (const word of words) {
        const rawSpeaker = word?.speaker;
        if (rawSpeaker === null || rawSpeaker === undefined || rawSpeaker === '') {
            continue;
        }
        const speakerId = `speaker_${rawSpeaker}`;
        counts.set(speakerId, (counts.get(speakerId) || 0) + 1);
    }

    let bestSpeaker: string | null = null;
    let bestCount = 0;
    counts.forEach((count, speakerId) => {
        if (count > bestCount) {
            bestSpeaker = speakerId;
            bestCount = count;
        }
    });

    return bestSpeaker;
}
