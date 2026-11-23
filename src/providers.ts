// Provider contracts. Implementations live beside these types.
// Core pipeline depends ONLY on these interfaces, never on Instagram/Gemini specifics.

export interface DiscoveredReel {
  instagramMediaId: string;
  reelUrl: string;
  publishedAt?: string | null;
  caption?: string | null;
}

export interface DiscoveryOptions {
  /** Only return reels newer than this (before overlap window is applied by sync service). */
  since?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface DiscoveryResult {
  reels: DiscoveredReel[];
  nextCursor?: string | null;
}

export interface ReelDiscoveryProvider {
  readonly name: string;
  discoverReels(username: string, options?: DiscoveryOptions): Promise<DiscoveryResult>;
}

export interface TranscriptionInput {
  audioPath: string;
  mimeType?: string;
}
export interface TranscriptionResult {
  text: string;
  language?: string;
}
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export interface FormattingInput {
  rawTranscript: string;
  caption?: string | null;
}
export interface FormattedContent {
  heading: string;
  markdownBody: string;
}
export interface FormattingProvider {
  readonly name: string;
  format(input: FormattingInput): Promise<FormattedContent>;
}

export interface MediaHandle {
  videoPath: string;
  cleanup(): Promise<void>;
}
export interface MediaProvider {
  readonly name: string;
  /**
   * Obtain playable media for a reel + derive an audio file path.
   * `mediaId` is the Instagram media ID (Graph numeric id when discovered
   * via the Graph API); providers that download from Graph need it because
   * the permalink shortcode is not the API id.
   */
  fetchAudio(reelUrl: string, workDir: string, mediaId?: string): Promise<{ audioPath: string; cleanup(): Promise<void> }>;
}
