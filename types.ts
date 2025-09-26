export type AppStatus = 'input' | 'scanning' | 'chat';

export type LinkStatus = 'pending' | 'scanning' | 'scanned' | 'failed';

export interface DiscoveredLink {
  url: string;
  status: LinkStatus;
  title: string;
  textContent?: string;
  htmlContent?: string;
}

export type AssetType = 'image' | 'pdf' | 'video';

export interface DiscoveredAsset {
    url: string;
    type: AssetType;
    sourcePage: string;
}

export interface SeoAnalysisResult {
  title: { text: string; length: number; status: 'ok' | 'short' | 'long' | 'missing' };
  description: { text: string; length: number; status: 'ok' | 'short' | 'long' | 'missing' };
  h1: { count: number; texts: string[]; status: 'ok' | 'multiple' | 'missing' };
  headings: { h2: number; h3: number; h4: number; h5: number; h6: number };
  images: { total: number; missingAlt: number; status: 'ok' | 'issues' };
  viewport: { present: boolean; status: 'ok' | 'missing' };
  wordCount: number;
  structuredData: { present: boolean; status: 'ok' | 'missing' };
}

export interface TextChatMessage {
  id: string;
  type: 'text';
  text: string;
  sender: 'user' | 'bot';
}

export interface FunctionCallChatMessage {
  id: string;
  type: 'function_call';
  functionCall: any; // Simplified for this context, but would be TypedFunctionCall in SDK
  sender: 'bot';
}

export type ChatMessage = TextChatMessage | FunctionCallChatMessage;