import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Chat as GenAIChat, GenerateContentResponse } from '@google/genai';
import UrlInput from './components/UrlInput';
import ScanningProgress from './components/ScanningProgress';
import Chat from './components/Chat';
import AssetExplorer from './components/SiteMap';
import { BrainCircuitIcon } from './components/icons/BrainCircuitIcon';
import { SitemapIcon } from './components/icons/SitemapIcon';
import { scanPage, extractStructuredData } from './utils/crawler';
import { analyzeSeo } from './utils/seoAnalyzer';
import { createChatSession } from './services/geminiService';
import { fetchAndEncodeImage } from './utils/imageHelper';
import type { AppStatus, ChatMessage, DiscoveredLink, LinkStatus, DiscoveredAsset, AssetType, TextChatMessage, FunctionCallChatMessage } from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>('input');
  const [error, setError] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [discoveredLinks, setDiscoveredLinks] = useState<Map<string, DiscoveredLink>>(new Map());
  const [discoveredAssets, setDiscoveredAssets] = useState<Map<string, DiscoveredAsset>>(new Map());
  const [isSitemapOpen, setIsSitemapOpen] = useState(false);
  const [isFullScanning, setIsFullScanning] = useState(false);
  const fullScanAbortController = useRef<AbortController | null>(null);
  
  const chatRef = useRef<GenAIChat | null>(null);
  const currentUrlRef = useRef<string>('');

  useEffect(() => {
    document.body.classList.toggle('no-scroll', status !== 'input');
  }, [status]);
  
  const addMessage = (message: Omit<TextChatMessage, 'id'> | Omit<FunctionCallChatMessage, 'id'>) => {
    setChatHistory(prev => [...prev, { ...message, id: Date.now().toString() + Math.random() }]);
  };

  const updateLinkStatus = (url: string, status: LinkStatus, data: Partial<DiscoveredLink> = {}) => {
    setDiscoveredLinks(prev => new Map(prev).set(url, { ...prev.get(url)!, status, ...data }));
  };
  
  const addDiscoveredAssets = (assets: DiscoveredAsset[]) => {
      setDiscoveredAssets(prev => {
          const newMap = new Map(prev);
          assets.forEach(asset => {
              if (!newMap.has(asset.url)) {
                  newMap.set(asset.url, asset);
              }
          });
          return newMap;
      });
  };

  const processStreamAndAddMessages = async (responseStream: AsyncGenerator<GenerateContentResponse>) => {
    let accumulatedText = '';
    let accumulatedFunctionCalls: any[] | undefined;

    for await (const chunk of responseStream) {
        // Manually iterate through parts to build text, avoiding the .text accessor which can trigger warnings.
        if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
                if (part.text) {
                    accumulatedText += part.text;
                }
            }
        }
        // Use the convenient accessor for function calls.
        if (chunk.functionCalls) {
            accumulatedFunctionCalls = chunk.functionCalls;
        }
    }

    const trimmedText = accumulatedText.trim();
    if (trimmedText) {
        addMessage({
            type: 'text',
            text: trimmedText,
            sender: 'bot'
        });
    }

    if (accumulatedFunctionCalls) {
        // Assuming we only handle the first function call for now
        addMessage({
            type: 'function_call',
            functionCall: accumulatedFunctionCalls[0],
            sender: 'bot'
        });
    }

    if (!trimmedText && !accumulatedFunctionCalls) {
        addMessage({
            type: 'text',
            text: "I received a response, but it was empty. Can you try rephrasing?",
            sender: 'bot'
        });
    }
  };


  const handleInitialScan = async (url: string) => {
    setStatus('scanning');
    setError(null);
    currentUrlRef.current = url;
    chatRef.current = createChatSession();

    try {
      const { textContent, links, assets, title, htmlContent } = await scanPage(url);
      const initialLink: DiscoveredLink = { url, status: 'scanned', title, textContent, htmlContent };
      
      const newLinksMap = new Map<string, DiscoveredLink>();
      newLinksMap.set(url, initialLink);
      links.forEach(linkUrl => {
        if (!newLinksMap.has(linkUrl)) {
          newLinksMap.set(linkUrl, { url: linkUrl, status: 'pending', title: 'Unknown Title' });
        }
      });
      
      setDiscoveredLinks(newLinksMap);
      addDiscoveredAssets(assets);
      setStatus('chat');
      
      const initialPagesPayload = JSON.stringify(Array.from(newLinksMap.values()).map(l => ({ url: l.url, title: l.title, status: l.status })), null, 2);

      const responseStream = await chatRef.current.sendMessageStream({
          message: `The initial scan of ${url} is complete. The page title is "${title}". Here is the text content: "${textContent.substring(0, 1000)}...". I also found these links: ${initialPagesPayload}. Please provide your initial analysis and suggest key pages to scan next.`,
      });
      
      await processStreamAndAddMessages(responseStream);

    } catch (e: any) {
      console.error(e);
      setError(e.message || 'An unknown error occurred during the initial scan.');
      setStatus('input');
    }
  };

 const handleFunctionCallResponse = async (approved: boolean, functionCall: any) => {
    setChatHistory(prev => prev.filter(msg => msg.type !== 'function_call' || msg.functionCall !== functionCall));

    if (!approved) {
        addMessage({ type: 'text', text: "Okay, I won't proceed with that action. How else can I help?", sender: 'bot' });
        return;
    }
    
    let resultPayload = '';
    let userMessage = '';

    if (functionCall.name === 'scanPages') {
        const urlsToScan: string[] = functionCall.args.urls;
        userMessage = `User approved scanning: ${urlsToScan.join(', ')}`;
        const scanPromises = urlsToScan.map(async (scanUrl) => {
            try {
                updateLinkStatus(scanUrl, 'scanning');
                const { textContent, links, assets, title, htmlContent } = await scanPage(scanUrl);
                updateLinkStatus(scanUrl, 'scanned', { textContent, title, htmlContent });
                links.forEach(linkUrl => {
                    setDiscoveredLinks(prev => {
                        if (!prev.has(linkUrl)) {
                            return new Map(prev).set(linkUrl, { url: linkUrl, status: 'pending', title: 'Unknown Title' });
                        }
                        return prev;
                    });
                });
                addDiscoveredAssets(assets);
                return { url: scanUrl, success: true, title, content: textContent.substring(0, 1000) };
            } catch (e: any) {
                updateLinkStatus(scanUrl, 'failed');
                return { url: scanUrl, success: false, error: e.message };
            }
        });
        const results = await Promise.all(scanPromises);
        resultPayload = JSON.stringify(results);

    } else if (functionCall.name === 'extractDataFromPage') {
        const { url, dataType } = functionCall.args;
        userMessage = `User approved data extraction ('${dataType}') for: ${url}`;
        
        const linkData = discoveredLinks.get(url);
        if (linkData?.status === 'scanned' && linkData.htmlContent) {
            const extractedData = extractStructuredData(linkData.htmlContent, dataType);
            resultPayload = JSON.stringify({ success: true, data: extractedData });
        } else {
            resultPayload = JSON.stringify({ success: false, error: `Page ${url} has not been scanned yet. Please use scanPages first.` });
        }
    } else if (functionCall.name === 'performSeoAnalysis') {
        const { url } = functionCall.args;
        userMessage = `User approved SEO Analysis for: ${url}`;
    
        const linkData = discoveredLinks.get(url);
        if (linkData?.status === 'scanned' && linkData.htmlContent) {
            const analysisResult = analyzeSeo(linkData.htmlContent);
            resultPayload = JSON.stringify({ success: true, data: analysisResult });
        } else {
            resultPayload = JSON.stringify({ success: false, error: `Page ${url} has not been scanned yet. Please use scanPages first.` });
        }
    } else if (functionCall.name === 'analyzeImageFromUrl') {
         const imageUrl = functionCall.args.url;
         userMessage = `User approved image analysis for: ${imageUrl}`;
         try {
            const { base64Data, mimeType } = await fetchAndEncodeImage(imageUrl);
            resultPayload = JSON.stringify({
                image: {
                    inlineData: { data: base64Data, mimeType }
                },
                prompt: functionCall.args.prompt
            });
         } catch (e: any) {
             resultPayload = JSON.stringify({ success: false, error: `Failed to fetch or encode image: ${e.message}`});
         }
    } else if (functionCall.name === 'scanAllPendingPages') {
        userMessage = `User approved a full site scan.`;
        await handleFullScan(true);
        resultPayload = JSON.stringify({ success: true, message: "Full scan initiated. I will provide a summary once a significant number of pages are scanned." });
    }

     if (chatRef.current) {
        const responseStream = await chatRef.current.sendMessageStream({
          message: [{
            functionResponse: {
              name: functionCall.name,
              response: { result: resultPayload },
            }
          }]
        });
        await processStreamAndAddMessages(responseStream);
     }
  };


  const handleSendMessage = async (text: string) => {
    if (!chatRef.current) return;
    addMessage({ type: 'text', text, sender: 'user' });
    const responseStream = await chatRef.current.sendMessageStream({ message: text });
    await processStreamAndAddMessages(responseStream);
  };

  const handleFullScan = async (isAiTriggered = false) => {
      setIsFullScanning(true);
      if(!isAiTriggered) setIsSitemapOpen(false);

      fullScanAbortController.current = new AbortController();
      const signal = fullScanAbortController.current.signal;

      const pendingUrls = Array.from(discoveredLinks.values())
          .filter(link => link.status === 'pending')
          .map(link => link.url);

      for (const url of pendingUrls) {
          if (signal.aborted) {
              console.log('Full scan aborted by user.');
              break;
          }
          try {
              updateLinkStatus(url, 'scanning');
              const { links, assets, title, textContent, htmlContent } = await scanPage(url);
              updateLinkStatus(url, 'scanned', { title, textContent, htmlContent });
              links.forEach(linkUrl => {
                  setDiscoveredLinks(prev => {
                      if (!prev.has(linkUrl)) {
                          return new Map(prev).set(linkUrl, { url: linkUrl, status: 'pending', title: 'Unknown Title' });
                      }
                      return prev;
                  });
              });
              addDiscoveredAssets(assets);
          } catch (e) {
              updateLinkStatus(url, 'failed');
              console.error(`Failed to scan ${url}:`, e);
          }
      }
      setIsFullScanning(false);
  };
  
  const handleStopFullScan = () => {
      if (fullScanAbortController.current) {
          fullScanAbortController.current.abort();
      }
      setIsFullScanning(false);
  };

  const handleReset = () => {
    setStatus('input');
    setError(null);
    setChatHistory([]);
    setDiscoveredLinks(new Map());
    setDiscoveredAssets(new Map());
    setIsSitemapOpen(false);
    setIsFullScanning(false);
    chatRef.current = null;
    currentUrlRef.current = '';
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 dark:bg-slate-950">
      <header className="flex-shrink-0 flex items-center justify-between py-3 px-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <BrainCircuitIcon className="h-7 w-7 text-sky-500" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 hidden sm:block">Website AI Scanner</h1>
        </div>
        {status === 'chat' && (
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSitemapOpen(true)} className="relative flex items-center gap-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold py-2 px-4 rounded-lg transition-colors">
              <SitemapIcon className="h-5 w-5"/>
              <span className="hidden md:inline">Asset Explorer</span>
              <span className="absolute -top-1 -right-1 flex h-5 w-5">
                  <span className="relative inline-flex rounded-full h-5 w-5 bg-sky-500 text-white text-xs items-center justify-center">
                      {discoveredLinks.size + discoveredAssets.size}
                  </span>
              </span>
            </button>
            <button onClick={handleReset} className="bg-slate-600 hover:bg-slate-700 text-white font-bold py-2 px-4 rounded-lg transition-colors">
              New Scan
            </button>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-hidden">
        {status === 'input' && <UrlInput onScan={handleInitialScan} error={error} disabled={false} />}
        {status === 'scanning' && <ScanningProgress />}
        {status === 'chat' && (
          <Chat
            messages={chatHistory}
            onSendMessage={handleSendMessage}
            onFunctionCallResponse={handleFunctionCallResponse}
          />
        )}
      </main>

      {isSitemapOpen && (
        <AssetExplorer
          links={Array.from(discoveredLinks.values())}
          assets={Array.from(discoveredAssets.values())}
          onClose={() => setIsSitemapOpen(false)}
          onManualScan={url => handleFunctionCallResponse(true, { name: 'scanPages', args: { urls: [url] }})}
          onFullScan={handleFullScan}
          isFullScanning={isFullScanning}
          onStopFullScan={handleStopFullScan}
        />
      )}
    </div>
  );
};

export default App;