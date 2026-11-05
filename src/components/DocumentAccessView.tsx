import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Shield, 
  Loader2, 
  KeyRound, 
  AlertTriangle, 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight, 
  ZoomIn, 
  ZoomOut, 
  Clock, 
  Lock, 
  Unlock, 
  CheckCircle2,
  Maximize2 
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Configure worker src for pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const BLOCK_PROGRESSION_DURATION_MS = 300 * 1000; // 5 minutes (300 seconds)
const VISITED_BLOCK_GRACE_DURATION_MS = 120 * 1000; // 2 minutes (120 seconds)
const BLOCK_PAGE_SIZE = 4;

export function getBlockIndexForPage(page: number): number {
  return Math.floor((Math.max(1, page) - 1) / BLOCK_PAGE_SIZE) + 1;
}

export function getBlockPageRange(blockIndex: number, totalPages?: number): { startPage: number; endPage: number } {
  const startPage = (Math.max(1, blockIndex) - 1) * BLOCK_PAGE_SIZE + 1;
  const maxPage = totalPages || 9999;
  const endPage = Math.min(startPage + BLOCK_PAGE_SIZE - 1, maxPage);
  return { startPage, endPage };
}

export interface BlockTimerState {
  blockIndex: number;
  startedAt: number;
  eligibilityExpiresAt: number;
  isEligibleForNext: boolean;
}

export interface VisitedBlockState {
  blockIndex: number;
  leftAt: number;
  graceExpiresAt: number;
}

export interface PersistedBlockSessionState {
  currentPage: number;
  activeBlock: number;
  blockTimers: Record<number, BlockTimerState>;
  visitedBlocks: Record<number, VisitedBlockState>;
  customerFirstName?: string;
  paperTitle?: string;
  unitCode?: string;
  savedAt: number;
}

function getStoredBlockSession(token: string): PersistedBlockSessionState | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const raw = window.sessionStorage.getItem(`godrery_block_session_${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activeBlock === 'number') {
      return parsed as PersistedBlockSessionState;
    }
  } catch (e) {
    // ignore parse error
  }
  return null;
}

function saveStoredBlockSession(token: string, state: Omit<PersistedBlockSessionState, 'savedAt'>) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(`godrery_block_session_${token}`, JSON.stringify({
      ...state,
      savedAt: Date.now()
    }));
  } catch (e) {
    // ignore write error
  }
}

interface PdfCanvasViewerProps {
  token: string;
  initialCustomerFirstName?: string;
  initialPaperTitle?: string;
  initialUnitCode?: string;
}

function PdfCanvasViewer({ 
  token,
  initialCustomerFirstName = '',
  initialPaperTitle = '',
  initialUnitCode = ''
}: PdfCanvasViewerProps) {
  const initialSaved = useRef(getStoredBlockSession(token)).current;
  const now = Date.now();

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState<number>(() => {
    if (initialSaved && typeof initialSaved.currentPage === 'number') {
      return initialSaved.currentPage;
    }
    return 1;
  });
  const [numPages, setNumPages] = useState(0);
  const [zoomMultiplier, setZoomMultiplier] = useState(1.0);
  const [baseFitScale, setBaseFitScale] = useState(1.0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState('');
  const [pageRenderError, setPageRenderError] = useState<string | null>(null);
  const [renderRetryTrigger, setRenderRetryTrigger] = useState(0);
  const [, setTickerTime] = useState(now);

  // Four-Page Block Model State
  const [activeBlock, setActiveBlock] = useState<number>(() => {
    if (initialSaved && typeof initialSaved.activeBlock === 'number') {
      return initialSaved.activeBlock;
    }
    return 1;
  });

  const [blockTimers, setBlockTimers] = useState<Record<number, BlockTimerState>>(() => {
    if (initialSaved && initialSaved.blockTimers) {
      const timers = { ...initialSaved.blockTimers };
      for (const [b, t] of Object.entries(timers)) {
        if (t && !t.isEligibleForNext && now >= t.eligibilityExpiresAt) {
          timers[Number(b)] = { ...t, isEligibleForNext: true };
        }
      }
      return timers;
    }
    return {
      1: {
        blockIndex: 1,
        startedAt: now,
        eligibilityExpiresAt: now + BLOCK_PROGRESSION_DURATION_MS,
        isEligibleForNext: false
      }
    };
  });

  const [visitedBlocks, setVisitedBlocks] = useState<Record<number, VisitedBlockState>>(() => {
    if (initialSaved && initialSaved.visitedBlocks) {
      return initialSaved.visitedBlocks;
    }
    return {};
  });

  const currentBlockTimer = blockTimers[activeBlock] || {
    blockIndex: activeBlock,
    startedAt: now,
    eligibilityExpiresAt: now + BLOCK_PROGRESSION_DURATION_MS,
    isEligibleForNext: false
  };

  const [blockRemainingSeconds, setBlockRemainingSeconds] = useState<number>(() => {
    if (currentBlockTimer.isEligibleForNext) return 0;
    return Math.max(0, Math.ceil((currentBlockTimer.eligibilityExpiresAt - now) / 1000));
  });

  // Persist session to sessionStorage on state changes
  useEffect(() => {
    saveStoredBlockSession(token, {
      currentPage,
      activeBlock,
      blockTimers,
      visitedBlocks,
      customerFirstName: initialCustomerFirstName,
      paperTitle: initialPaperTitle,
      unitCode: initialUnitCode
    });
  }, [token, currentPage, activeBlock, blockTimers, visitedBlocks, initialCustomerFirstName, initialPaperTitle, initialUnitCode]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const currentUnscaledDimRef = useRef<{ width: number; height: number } | null>(null);

  // Monotonic client clock anchor
  const timeAnchorRef = useRef<{ perfNow: number; wallNow: number }>({
    perfNow: typeof performance !== 'undefined' ? performance.now() : 0,
    wallNow: Date.now()
  });

  const getMonotonicNow = useCallback(() => {
    if (typeof performance === 'undefined') return Date.now();
    const elapsed = performance.now() - timeAnchorRef.current.perfNow;
    return timeAnchorRef.current.wallNow + elapsed;
  }, []);

  // Viewport Fit Scale computation: calculates fit for the container with padding
  const updateFitScale = useCallback(() => {
    if (!containerRef.current || !currentUnscaledDimRef.current) return;
    const container = containerRef.current;
    const availW = Math.max(container.clientWidth - 48, 200);
    const availH = Math.max(container.clientHeight - 48, 200);
    const { width, height } = currentUnscaledDimRef.current;
    if (width > 0 && height > 0) {
      const calculatedFit = Math.min(availW / width, availH / height);
      setBaseFitScale(calculatedFit);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      updateFitScale();
    });
    observer.observe(container);
    window.addEventListener('resize', updateFitScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateFitScale);
    };
  }, [updateFitScale]);

  const effectiveScale = (baseFitScale || 1.0) * zoomMultiplier;

  // Arrival notification: notifies server when page finishes rendering
  const notifyArrival = useCallback(async (pageNum: number) => {
    try {
      const res = await fetch(`/api/document/session/${token}/arrive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: pageNum })
      });
      const data = await res.json();
      if (data.success && data.arrived) {
        if (data.activeBlock && data.activeBlock !== activeBlock) {
          setActiveBlock(data.activeBlock);
        }
        if (data.visitedBlocks) {
          setVisitedBlocks(data.visitedBlocks);
        }
        setBlockTimers(prev => ({
          ...prev,
          [data.activeBlock]: {
            blockIndex: data.activeBlock,
            startedAt: prev[data.activeBlock]?.startedAt || Date.now(),
            eligibilityExpiresAt: prev[data.activeBlock]?.eligibilityExpiresAt || (Date.now() + (data.remainingSeconds * 1000)),
            isEligibleForNext: Boolean(data.isEligibleForNext)
          }
        }));
        if (typeof data.remainingSeconds === 'number') {
          setBlockRemainingSeconds(data.remainingSeconds);
        }
      }
    } catch (err) {
      // Offline fallback: keep existing block timer running locally
    }
  }, [token, activeBlock]);

  // Sync session state from server
  const syncServerSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/document/session/${token}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) {
        timeAnchorRef.current = {
          perfNow: typeof performance !== 'undefined' ? performance.now() : 0,
          wallNow: Date.now()
        };
        if (data.currentPage && data.currentPage !== currentPage) {
          setCurrentPage(data.currentPage);
        }
        if (typeof data.activeBlock === 'number') {
          setActiveBlock(data.activeBlock);
        }
        if (data.visitedBlocks) {
          setVisitedBlocks(data.visitedBlocks);
        }
        if (data.blockTimer) {
          setBlockTimers(prev => ({
            ...prev,
            [data.blockTimer.blockIndex]: {
              blockIndex: data.blockTimer.blockIndex,
              startedAt: data.blockTimer.startedAt,
              eligibilityExpiresAt: data.blockTimer.eligibilityExpiresAt,
              isEligibleForNext: Boolean(data.blockTimer.isEligibleForNext)
            }
          }));
          setBlockRemainingSeconds(data.blockTimer.remainingSeconds);
        }
      }
    } catch (e) {
      // offline / network error - timer continues locally
    }
  }, [token, currentPage]);

  // Initial session sync
  useEffect(() => {
    syncServerSession();
  }, [syncServerSession]);

  // Revalidate with server when tab regains visibility or network returns
  useEffect(() => {
    const handleOnline = () => syncServerSession();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncServerSession();
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncServerSession]);

  // Master countdown timer interval (runs every 500ms)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = getMonotonicNow();

      // Block 5-minute eligibility timer
      const bTimer = blockTimers[activeBlock];
      if (bTimer) {
        if (bTimer.isEligibleForNext) {
          setBlockRemainingSeconds(0);
        } else {
          const bRem = Math.max(0, Math.ceil((bTimer.eligibilityExpiresAt - now) / 1000));
          setBlockRemainingSeconds(bRem);
          if (bRem <= 0) {
            setBlockTimers(prev => ({
              ...prev,
              [activeBlock]: { ...prev[activeBlock], isEligibleForNext: true }
            }));
          }
        }
      }

      setTickerTime(now);
    }, 500);

    return () => clearInterval(timer);
  }, [activeBlock, blockTimers, getMonotonicNow]);

  // Load PDF Document
  useEffect(() => {
    let isMounted = true;
    const loadPdf = async () => {
      try {
        const res = await fetch(`/api/document/stream/${token}`);
        if (!res.ok) {
          throw new Error('Failed to load document stream.');
        }
        const arrayBuffer = await res.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const doc = await loadingTask.promise;
        if (isMounted) {
          setPdfDoc(doc);
          setNumPages(doc.numPages);
          setLoadingPdf(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setPdfError(err?.message || 'Failed to render PDF document.');
          setLoadingPdf(false);
        }
      }
    };
    loadPdf();
    return () => { isMounted = false; };
  }, [token]);

  // Render Current Page onto Canvas
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let isCancelled = false;
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    pdfDoc.getPage(currentPage).then((page: any) => {
      if (isCancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const unscaledViewport = page.getViewport({ scale: 1.0 });
      currentUnscaledDimRef.current = { width: unscaledViewport.width, height: unscaledViewport.height };
      updateFitScale();

      const viewport = page.getViewport({ scale: effectiveScale });
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      const renderTask = page.render(renderContext);
      renderTaskRef.current = renderTask;
      renderTask.promise.then(() => {
        if (!isCancelled) {
          setPageRenderError(null);
          notifyArrival(currentPage);
        }
      }).catch((err: any) => {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Page render error:', err);
          if (!isCancelled) {
            setPageRenderError('Unable to render page content. Please click retry.');
          }
        }
      });
    }).catch((pageErr: any) => {
      console.error('pdfDoc.getPage error:', pageErr);
      if (!isCancelled) {
        setPageRenderError('Unable to load page ' + currentPage + ' from document.');
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [pdfDoc, currentPage, effectiveScale, updateFitScale, notifyArrival, renderRetryTrigger]);

  // Block print shortcuts (Ctrl+P, Cmd+P) and save/download shortcuts (Ctrl+S, Cmd+S) completely
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (
        e.key === 'p' || e.key === 'P' ||
        e.key === 's' || e.key === 'S'
      )) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);

  // Navigation Handler for Four-Page Block Model with 2-Minute Visited Grace Period
  const handleRequestNavigation = async (targetPage: number) => {
    if (targetPage === currentPage || targetPage < 1 || targetPage > numPages) return;

    const targetBlock = getBlockIndexForPage(targetPage);
    const now = getMonotonicNow();

    // Check backward navigation into previous blocks:
    if (targetBlock < activeBlock) {
      const vb = visitedBlocks[targetBlock];
      if (!vb || now >= vb.graceExpiresAt) {
        // Grace period expired or never visited
        return;
      }
    }

    // Prohibit skipping blocks forward
    if (targetBlock > activeBlock + 1) {
      return;
    }

    // Moving into immediate next block requires eligibility (5 minutes active on current block)
    if (targetBlock === activeBlock + 1) {
      const activeTimer = blockTimers[activeBlock];
      if (!activeTimer?.isEligibleForNext) {
        return;
      }
    }

    // Call server navigation endpoint for authoritative validation
    try {
      const res = await fetch(`/api/document/session/${token}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPage })
      });
      const data = await res.json();

      if (!data.success) {
        if (data.error === 'next_block_not_eligible' && typeof data.remainingSeconds === 'number') {
          setBlockRemainingSeconds(data.remainingSeconds);
        }
        return;
      }

      if (data.navigated) {
        setCurrentPage(targetPage);
        if (data.visitedBlocks) {
          setVisitedBlocks(data.visitedBlocks);
        }
        if (data.blockAdvanced && data.activeBlock) {
          setActiveBlock(data.activeBlock);
          const nowTime = Date.now();
          setVisitedBlocks(prev => ({
            ...prev,
            [activeBlock]: {
              blockIndex: activeBlock,
              leftAt: nowTime,
              graceExpiresAt: nowTime + VISITED_BLOCK_GRACE_DURATION_MS
            }
          }));
          setBlockTimers(prev => ({
            ...prev,
            [data.activeBlock]: {
              blockIndex: data.activeBlock,
              startedAt: nowTime,
              eligibilityExpiresAt: nowTime + BLOCK_PROGRESSION_DURATION_MS,
              isEligibleForNext: false
            }
          }));
          setBlockRemainingSeconds(300);
        }
      }
    } catch (e) {
      // Local fallback for offline / transient error
      if (targetBlock === activeBlock) {
        setCurrentPage(targetPage);
      } else if (targetBlock < activeBlock) {
        const vb = visitedBlocks[targetBlock];
        if (vb && now < vb.graceExpiresAt) {
          setCurrentPage(targetPage);
        }
      } else if (targetBlock === activeBlock + 1 && blockTimers[activeBlock]?.isEligibleForNext) {
        const nowTime = Date.now();
        setVisitedBlocks(prev => ({
          ...prev,
          [activeBlock]: {
            blockIndex: activeBlock,
            leftAt: nowTime,
            graceExpiresAt: nowTime + VISITED_BLOCK_GRACE_DURATION_MS
          }
        }));
        setActiveBlock(targetBlock);
        setCurrentPage(targetPage);
        setBlockTimers(prev => ({
          ...prev,
          [targetBlock]: {
            blockIndex: targetBlock,
            startedAt: nowTime,
            eligibilityExpiresAt: nowTime + BLOCK_PROGRESSION_DURATION_MS,
            isEligibleForNext: false
          }
        }));
        setBlockRemainingSeconds(300);
      }
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  // Determine navigation capabilities
  const nowForRender = getMonotonicNow();
  const currentBlockRange = getBlockPageRange(activeBlock, numPages);
  const isEligibleForNext = Boolean(blockTimers[activeBlock]?.isEligibleForNext);

  const prevPageNum = currentPage - 1;
  const prevPageBlock = prevPageNum >= 1 ? getBlockIndexForPage(prevPageNum) : null;
  const canGoPrev = prevPageNum >= 1 && (
    prevPageBlock === activeBlock ||
    Boolean(prevPageBlock && visitedBlocks[prevPageBlock] && nowForRender < visitedBlocks[prevPageBlock].graceExpiresAt)
  );

  const nextPageNum = currentPage + 1;
  const nextPageBlock = nextPageNum <= numPages ? getBlockIndexForPage(nextPageNum) : null;
  const canGoNext = nextPageNum <= numPages && (
    nextPageBlock === activeBlock ||
    (nextPageBlock === activeBlock + 1 && isEligibleForNext) ||
    Boolean(nextPageBlock && visitedBlocks[nextPageBlock] && nowForRender < visitedBlocks[nextPageBlock].graceExpiresAt)
  );

  // Loading Screen
  if (loadingPdf) {
    return (
      <div className="flex-grow w-full h-full flex flex-col items-center justify-center bg-slate-950 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-[#00D26A]" />
        <p className="text-sm text-slate-400">Loading secure document canvas...</p>
      </div>
    );
  }

  // Error Screen
  if (pdfError) {
    return (
      <div className="flex-grow w-full h-full flex items-center justify-center bg-slate-950 p-6 text-center">
        <div className="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-4 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">Document Error</h2>
          <p className="text-sm text-slate-400">{pdfError}</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="flex-grow w-full flex flex-col bg-slate-950 relative overflow-hidden select-none"
      onContextMenu={e => e.preventDefault()}
    >
      {/* Suppress all printing */}
      <style>{`
        @media print {
          body, html, * {
            display: none !important;
            visibility: hidden !important;
          }
        }
      `}</style>

      {/* Watermark Overlay */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10 opacity-[0.03] overflow-hidden select-none">
        <div className="text-6xl font-black text-white rotate-[-35deg] whitespace-nowrap tracking-widest">
          GODRERY PUBLISHERS • SECURE VIEW ONLY • NO DOWNLOADING
        </div>
      </div>

      {/* Top Status Bar: Timers and Gating Notices */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0 z-20 shadow-md">
        
        {/* Navigation Controls */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleRequestNavigation(currentPage - 1)}
            disabled={!canGoPrev}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
            title={
              currentPage <= 1
                ? "First page"
                : prevPageBlock && prevPageBlock < activeBlock && (!visitedBlocks[prevPageBlock] || nowForRender >= visitedBlocks[prevPageBlock].graceExpiresAt)
                  ? `Block ${prevPageBlock} is permanently locked`
                  : `Previous Page (${currentPage - 1})`
            }
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Prev</span>
          </button>

          {/* Page Selector Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-300">
              Page
            </span>
            <select
              value={currentPage}
              onChange={e => handleRequestNavigation(Number(e.target.value))}
              className="bg-slate-800 text-white text-xs rounded-lg px-2 py-1 border border-slate-700 outline-none focus:border-[#00D26A]"
            >
              {Array.from({ length: numPages }, (_, i) => i + 1).map(p => {
                const pBlock = getBlockIndexForPage(p);
                const isCurrentBlock = pBlock === activeBlock;
                const isPastBlock = pBlock < activeBlock;
                const isNextBlock = pBlock === activeBlock + 1;
                const isFutureLocked = pBlock > activeBlock + 1;

                let label = `Page ${p} (Block ${pBlock})`;
                let disabled = false;

                if (isCurrentBlock) {
                  label = `Page ${p} (Block ${pBlock} • Active)`;
                  disabled = false;
                } else if (isPastBlock) {
                  const vb = visitedBlocks[pBlock];
                  if (vb && nowForRender < vb.graceExpiresAt) {
                    const graceSecs = Math.max(0, Math.ceil((vb.graceExpiresAt - nowForRender) / 1000));
                    label = `Page ${p} (Block ${pBlock} • Closes in ${formatTime(graceSecs)})`;
                    disabled = false;
                  } else {
                    label = `Page ${p} (Block ${pBlock} • Locked)`;
                    disabled = true;
                  }
                } else if (isNextBlock) {
                  if (isEligibleForNext) {
                    label = `Page ${p} (Block ${pBlock} • Eligible to Enter)`;
                    disabled = false;
                  } else {
                    label = `Page ${p} (Block ${pBlock} • Unlocks in ${formatTime(blockRemainingSeconds)})`;
                    disabled = true;
                  }
                } else if (isFutureLocked) {
                  label = `Page ${p} (Block ${pBlock} • Locked)`;
                  disabled = true;
                }

                return (
                  <option key={p} value={p} disabled={disabled}>
                    {label}
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-slate-400">of {numPages}</span>
          </div>

          <button
            onClick={() => handleRequestNavigation(currentPage + 1)}
            disabled={!canGoNext}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
            title={
              currentPage >= numPages
                ? "Last page"
                : nextPageBlock === activeBlock
                  ? `Next Page (${currentPage + 1})`
                  : nextPageBlock === activeBlock + 1 && isEligibleForNext
                    ? `Enter Block ${activeBlock + 1} (Page ${currentPage + 1})`
                    : `Next block unlocks in ${formatTime(blockRemainingSeconds)}`
            }
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Dynamic Timers and Reading Status */}
        <div className="flex flex-wrap items-center gap-3">
          
          {/* Active Block Indicator Badge */}
          <div className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 px-3 py-1 rounded-full text-blue-400 text-xs font-semibold">
            <span>Block {activeBlock} (Pages {currentBlockRange.startPage}–{currentBlockRange.endPage})</span>
          </div>

          {/* Block Eligibility Countdown / Status Badge */}
          {isEligibleForNext ? (
            <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 rounded-full text-emerald-400 text-xs font-semibold">
              <Unlock className="w-3.5 h-3.5 shrink-0" />
              <span>Block {activeBlock + 1} Eligible to Enter</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/30 px-3 py-1 rounded-full text-rose-400 text-xs font-medium">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>Next Block Unlocks In: <strong>{formatTime(blockRemainingSeconds)}</strong></span>
            </div>
          )}

          {/* Visited Block Grace Countdown Badges */}
          {Object.values(visitedBlocks).map(vb => {
            const graceRem = Math.max(0, Math.ceil((vb.graceExpiresAt - nowForRender) / 1000));
            if (graceRem <= 0) return null;
            return (
              <div 
                key={vb.blockIndex} 
                className="flex items-center gap-1.5 bg-amber-500/15 border border-amber-500/40 px-3 py-1 rounded-full text-amber-300 text-xs font-semibold shadow-xs"
              >
                <Clock className="w-3.5 h-3.5 shrink-0 animate-pulse text-amber-400" />
                <span>Block {vb.blockIndex} Closes In: <strong>{formatTime(graceRem)}</strong></span>
              </div>
            );
          })}

          {/* Zoom & Viewport Fit Controls (Always interactive during reading) */}
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setZoomMultiplier(1.0)}
              className={`px-2 py-1 rounded text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1 ${
                zoomMultiplier === 1.0 ? 'bg-[#00D26A] text-slate-950 font-bold' : 'text-slate-300 hover:bg-slate-700'
              }`}
              title="Fit Page within Viewport"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Fit</span>
            </button>
            <button
              type="button"
              onClick={() => setZoomMultiplier(z => Math.max(+(z - 0.25).toFixed(2), 0.5))}
              className="p-1 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              title="Zoom Out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium text-slate-300 w-12 text-center">
              {zoomMultiplier === 1.0 ? 'Fit' : `${Math.round(zoomMultiplier * 100)}%`}
            </span>
            <button
              type="button"
              onClick={() => setZoomMultiplier(z => Math.min(+(z + 0.25).toFixed(2), 3.0))}
              className="p-1 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              title="Zoom In"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Canvas Container with Auto-Fit Viewport & Clean Edge-to-Edge Zoom Scrolling */}
      <div 
        ref={containerRef}
        className="flex-grow overflow-auto p-4 sm:p-6 relative z-0"
      >
        <div className="min-w-full min-h-full flex items-center justify-center">
          <div 
            id="godrery-canvas-wrapper"
            className="shadow-2xl bg-white rounded-lg overflow-hidden border border-slate-700 relative m-auto shrink-0 min-w-[200px] min-h-[200px]"
          >
            {pageRenderError && (
              <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center p-4 text-center z-30">
                <AlertTriangle className="w-8 h-8 text-rose-400 mb-2" />
                <p className="text-xs sm:text-sm text-slate-200 mb-3">{pageRenderError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setPageRenderError(null);
                    setRenderRetryTrigger(t => t + 1);
                  }}
                  className="px-4 py-2 bg-[#00D26A] text-slate-950 font-bold rounded-lg text-xs hover:bg-[#00b85c] cursor-pointer"
                >
                  Retry Page Render
                </button>
              </div>
            )}
            <canvas 
              id="godrery-active-canvas"
              ref={canvasRef} 
              className="block shadow-lg" 
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocumentAccessView() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [requireNames, setRequireNames] = useState(false);
  
  const [firstName, setFirstName] = useState('');
  const [secondName, setSecondName] = useState('');

  // Customer Welcome Header Metadata
  const [customerFirstName, setCustomerFirstName] = useState('');
  const [paperTitle, setPaperTitle] = useState('');
  const [unitCode, setUnitCode] = useState('');
  
  const [isVerifying, setIsVerifying] = useState(false);

  useEffect(() => {
    // Extract token from path: /document/access/<token>
    const path = window.location.pathname;
    const match = path.match(/\/document\/access\/(.+)/);
    if (match && match[1]) {
      const t = match[1];
      setToken(t);
      verifyToken(t);
    } else {
      setError("Invalid or missing access link.");
      setLoading(false);
    }
  }, []);

  const verifyToken = async (t: string) => {
    try {
      const res = await fetch('/api/document/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t })
      });
      const data = await res.json();
      if (data.success) {
        if (data.firstName) setCustomerFirstName(data.firstName);
        if (data.paperTitle) setPaperTitle(data.paperTitle);
        if (data.unitCode) setUnitCode(data.unitCode);
        setVerified(true);
      } else if (data.requireNames) {
        if (data.firstName) setCustomerFirstName(data.firstName);
        if (data.paperTitle) setPaperTitle(data.paperTitle);
        if (data.unitCode) setUnitCode(data.unitCode);
        setRequireNames(true);
      } else {
        setError(data.error || 'Access denied');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyNames = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsVerifying(true);
    setError('');
    try {
      const res = await fetch('/api/document/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, firstName, secondName })
      });
      const data = await res.json();
      if (data.success) {
        if (data.firstName) setCustomerFirstName(data.firstName);
        if (data.paperTitle) setPaperTitle(data.paperTitle);
        if (data.unitCode) setUnitCode(data.unitCode);
        setRequireNames(false);
        setVerified(true);
      } else {
        setError(data.error || 'Verification failed');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#052b1b] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#00D26A]" />
      </div>
    );
  }

  if (verified) {
    return (
      <div className="w-full h-screen bg-[#052b1b] flex flex-col">
        {/* Customer Welcome Header */}
        <div className="w-full bg-[#031d12] border-b border-slate-800 px-4 py-3 sm:px-6 flex flex-wrap items-center justify-between gap-3 shadow-sm shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#00D26A]/20 text-[#00D26A] flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[#00D26A] tracking-wider uppercase">
                  Welcome, {customerFirstName || 'Customer'}
                </span>
                {unitCode && (
                  <span className="text-[10px] bg-slate-800 text-slate-300 font-mono px-1.5 py-0.5 rounded border border-slate-700">
                    {unitCode}
                  </span>
                )}
              </div>
              <h1 className="text-sm sm:text-base font-bold text-white tracking-tight leading-tight">
                {paperTitle || 'Protected Document'}
              </h1>
            </div>
          </div>
          <button 
            onClick={() => window.location.href = '/'} 
            className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Home</span>
          </button>
        </div>
        <PdfCanvasViewer 
          token={token} 
          initialCustomerFirstName={customerFirstName}
          initialPaperTitle={paperTitle}
          initialUnitCode={unitCode}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#052b1b] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="p-6 sm:p-8 space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-2">
            {error ? <AlertTriangle className="w-8 h-8 text-rose-500" /> : <Shield className="w-8 h-8 text-[#00D26A]" />}
          </div>
          
          <div className="text-center space-y-1">
            <h2 className="text-xl sm:text-2xl font-black text-slate-900">
              {error ? "Access Denied" : "Verify Identity"}
            </h2>
            <p className="text-sm text-slate-500 leading-snug">
              {error ? error : "Please confirm the names used during purchase to register this device for access."}
            </p>
            {!error && requireNames && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-4 text-left">
                <p className="text-xs text-amber-800 font-medium flex items-start gap-1.5 leading-relaxed">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <span><strong>Important:</strong> This document can only be opened on up to 3 devices. Once a device is registered, it counts toward your 3-device limit.</span>
                </p>
              </div>
            )}
          </div>

          {!error && requireNames && (
            <form onSubmit={handleVerifyNames} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1">
                  First Name
                </label>
                <input
                  type="text"
                  required
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-[#00D26A] focus:ring-2 focus:ring-[#00D26A]/20 text-slate-900 outline-none transition-all"
                  placeholder="e.g. John"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1">
                  Second Name
                </label>
                <input
                  type="text"
                  required
                  value={secondName}
                  onChange={e => setSecondName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-[#00D26A] focus:ring-2 focus:ring-[#00D26A]/20 text-slate-900 outline-none transition-all"
                  placeholder="e.g. Kamau"
                />
              </div>
              
              <button
                type="submit"
                disabled={isVerifying || !firstName.trim() || !secondName.trim()}
                className="w-full py-3.5 mt-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold rounded-xl transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-5 h-5" />
                    <span>OPEN DOCUMENT</span>
                  </>
                )}
              </button>
            </form>
          )}

          {error && (
            <button
              onClick={() => {
                setError('');
                setRequireNames(true);
              }}
              className="w-full py-3 bg-[#00D26A] hover:bg-[#00b85c] text-white font-bold rounded-xl transition-all shadow-md cursor-pointer"
            >
              Try Again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
