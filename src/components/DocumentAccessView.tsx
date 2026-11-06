import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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

export const BLOCK_PROGRESSION_DURATION_MS = 300 * 1000; // 5 minutes (300 seconds)
export const VISITED_BLOCK_GRACE_DURATION_MS = 120 * 1000; // 2 minutes (120 seconds)
export const BLOCK_PAGE_SIZE = 4;

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
  purchasedPages?: number[];
  totalPages?: number;
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

export function formatTime(secs: number): string {
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

// -------------------------------------------------------------
// Isolated Countdown Badge Subcomponents to Prevent Blinking
// -------------------------------------------------------------

export const BlockEligibilityBadge = React.memo(function BlockEligibilityBadge({
  isEligibleForNext,
  nextBlockNum,
  remainingSeconds
}: {
  isEligibleForNext: boolean;
  nextBlockNum: number | null;
  remainingSeconds: number;
}) {
  if (nextBlockNum === null) return null;

  if (isEligibleForNext) {
    return (
      <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full text-emerald-400 text-xs font-semibold whitespace-nowrap">
        <Unlock className="w-3.5 h-3.5 shrink-0" />
        <span>Block {nextBlockNum} Eligible to Enter</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/30 px-2.5 py-1 rounded-full text-rose-400 text-xs font-medium whitespace-nowrap">
      <Lock className="w-3.5 h-3.5 shrink-0" />
      <span>Next Block Unlocks In: <strong>{formatTime(remainingSeconds)}</strong></span>
    </div>
  );
});

export const VisitedGraceBadges = React.memo(function VisitedGraceBadges({
  visitedBlocks,
  now
}: {
  visitedBlocks: Record<number, VisitedBlockState>;
  now: number;
}) {
  const entries = Object.values(visitedBlocks);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(vb => {
        const graceRem = Math.max(0, Math.ceil((vb.graceExpiresAt - now) / 1000));
        if (graceRem <= 0) return null;
        return (
          <div 
            key={`grace-badge-${vb.blockIndex}`} 
            className="flex items-center gap-1.5 bg-amber-500/15 border border-amber-500/40 px-2.5 py-1 rounded-full text-amber-300 text-xs font-semibold whitespace-nowrap shadow-xs"
          >
            <Clock className="w-3.5 h-3.5 shrink-0 animate-pulse text-amber-400" />
            <span>Block {vb.blockIndex} Closes In: <strong>{formatTime(graceRem)}</strong></span>
          </div>
        );
      })}
    </>
  );
});

// -------------------------------------------------------------
// Individual High-DPI Page Canvas Component
// -------------------------------------------------------------

interface PageCanvasItemProps {
  pdfDoc: any;
  originalPage: number;
  pdfPageIndex: number;
  effectiveScale: number;
  dpr: number;
  isPrimary: boolean;
  onVisible: (page: number) => void;
}

const PageCanvasItem = React.memo(function PageCanvasItem({
  pdfDoc,
  originalPage,
  pdfPageIndex,
  effectiveScale,
  dpr,
  isPrimary,
  onVisible
}: PageCanvasItemProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendered, setIsRendered] = useState(false);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || pdfPageIndex < 1 || pdfPageIndex > pdfDoc.numPages) return;

    let isCancelled = false;
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    pdfDoc.getPage(pdfPageIndex).then((page: any) => {
      if (isCancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const unscaledViewport = page.getViewport({ scale: 1.0 });
      const cssWidth = Math.floor(unscaledViewport.width * effectiveScale);
      const cssHeight = Math.floor(unscaledViewport.height * effectiveScale);

      // High-DPI physical render scale:
      // Clamp render scale to 4.0 or max physical dimension 4096px to preserve GPU memory on mobile
      let renderScale = effectiveScale * dpr;
      if (renderScale * unscaledViewport.width > 4096 || renderScale * unscaledViewport.height > 4096) {
        renderScale = 4096 / Math.max(unscaledViewport.width, unscaledViewport.height);
      }

      const renderViewport = page.getViewport({ scale: renderScale });
      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      const renderContext = {
        canvasContext: context,
        viewport: renderViewport
      };

      const renderTask = page.render(renderContext);
      renderTaskRef.current = renderTask;
      renderTask.promise.then(() => {
        if (!isCancelled) {
          setIsRendered(true);
          setRenderError(null);
        }
      }).catch((err: any) => {
        if (err?.name !== 'RenderingCancelledException') {
          console.error(`Page ${originalPage} render error:`, err);
          if (!isCancelled) {
            setRenderError(`Unable to render page ${originalPage}`);
          }
        }
      });
    }).catch((err: any) => {
      console.error(`Page ${originalPage} load error:`, err);
      if (!isCancelled) {
        setRenderError(`Unable to load page ${originalPage}`);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [pdfDoc, pdfPageIndex, effectiveScale, dpr, originalPage]);

  // Track visibility for natural page arrival notification
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.4) {
          onVisible(originalPage);
        }
      }
    }, { threshold: [0.4, 0.7] });

    observer.observe(el);
    return () => observer.disconnect();
  }, [originalPage, onVisible]);

  return (
    <div 
      ref={wrapperRef}
      id={isPrimary ? "godrery-canvas-wrapper" : `godrery-canvas-wrapper-p${originalPage}`}
      data-page-num={originalPage}
      className="shadow-2xl bg-white rounded-lg overflow-hidden border border-slate-700 relative m-auto shrink-0 min-w-[200px] min-h-[200px]"
    >
      {renderError && (
        <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center p-4 text-center z-30">
          <AlertTriangle className="w-8 h-8 text-rose-400 mb-2" />
          <p className="text-xs sm:text-sm text-slate-200 mb-3">{renderError}</p>
        </div>
      )}
      {!isRendered && !renderError && (
        <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center z-20">
          <Loader2 className="w-6 h-6 animate-spin text-[#00D26A]" />
        </div>
      )}
      <canvas 
        id={isPrimary ? "godrery-active-canvas" : `godrery-canvas-p${originalPage}`}
        ref={canvasRef} 
        className="block shadow-lg" 
      />
      {/* Tiled diagonal watermark overlaid strictly on each canvas */}
      <div 
        className="absolute inset-0 pointer-events-none flex items-center justify-center z-10 opacity-[0.04] overflow-hidden select-none"
        aria-hidden="true"
      >
        <div className="text-4xl sm:text-6xl font-black text-slate-900 rotate-[-35deg] whitespace-nowrap tracking-widest">
          GODRERY PUBLISHERS • SECURE VIEW ONLY • PAGE {originalPage}
        </div>
      </div>
    </div>
  );
});

// -------------------------------------------------------------
// Main Canvas Viewer Component
// -------------------------------------------------------------

interface PdfCanvasViewerProps {
  token: string;
  initialCustomerFirstName?: string;
  initialPaperTitle?: string;
  initialUnitCode?: string;
  initialPurchasedPages?: number[] | null;
  initialTotalPages?: number | null;
}

function PdfCanvasViewer({ 
  token,
  initialCustomerFirstName = '',
  initialPaperTitle = '',
  initialUnitCode = '',
  initialPurchasedPages = null,
  initialTotalPages = null
}: PdfCanvasViewerProps) {
  const initialSaved = useRef(getStoredBlockSession(token)).current;
  const now = Date.now();

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [purchasedPages, setPurchasedPages] = useState<number[] | null>(() => {
    if (initialSaved?.purchasedPages && initialSaved.purchasedPages.length > 0) {
      return initialSaved.purchasedPages;
    }
    return initialPurchasedPages;
  });
  const [totalPages, setTotalPages] = useState<number>(() => {
    if (initialSaved?.totalPages) return initialSaved.totalPages;
    return initialTotalPages || 0;
  });

  const [currentPage, setCurrentPage] = useState<number>(() => {
    if (initialSaved && typeof initialSaved.currentPage === 'number') {
      return initialSaved.currentPage;
    }
    if (initialPurchasedPages && initialPurchasedPages.length > 0) {
      return initialPurchasedPages[0];
    }
    return 1;
  });

  const [numStreamPages, setNumStreamPages] = useState(0);
  const [zoomMultiplier, setZoomMultiplier] = useState(1.0);
  const [baseFitScale, setBaseFitScale] = useState(1.0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState('');
  const [tickerTime, setTickerTime] = useState(now);

  // Active Block State
  const [activeBlock, setActiveBlock] = useState<number>(() => {
    if (initialSaved && typeof initialSaved.activeBlock === 'number') {
      return initialSaved.activeBlock;
    }
    if (initialPurchasedPages && initialPurchasedPages.length > 0) {
      return getBlockIndexForPage(initialPurchasedPages[0]);
    }
    return 1;
  });

  const [blockTimers, setBlockTimers] = useState<Record<number, BlockTimerState>>(() => {
    const initBlock = (initialPurchasedPages && initialPurchasedPages.length > 0)
      ? getBlockIndexForPage(initialPurchasedPages[0])
      : 1;

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
      [initBlock]: {
        blockIndex: initBlock,
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

  const containerRef = useRef<HTMLDivElement>(null);
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

  // Save session state to sessionStorage
  useEffect(() => {
    saveStoredBlockSession(token, {
      currentPage,
      activeBlock,
      blockTimers,
      visitedBlocks,
      customerFirstName: initialCustomerFirstName,
      paperTitle: initialPaperTitle,
      unitCode: initialUnitCode,
      purchasedPages: purchasedPages || undefined,
      totalPages: totalPages || undefined
    });
  }, [token, currentPage, activeBlock, blockTimers, visitedBlocks, initialCustomerFirstName, initialPaperTitle, initialUnitCode, purchasedPages, totalPages]);

  // Compute purchased blocks sequence (LIFO or ordered pages entitlement)
  const purchasedBlocksList = useMemo(() => {
    if (purchasedPages && purchasedPages.length > 0) {
      return Array.from(new Set(purchasedPages.map(p => getBlockIndexForPage(p)))).sort((a, b) => a - b);
    }
    const maxP = totalPages || numStreamPages || 1;
    const maxB = getBlockIndexForPage(maxP);
    return Array.from({ length: maxB }, (_, i) => i + 1);
  }, [purchasedPages, totalPages, numStreamPages]);

  // Determine current block's authorized pages
  const authorizedPagesInActiveBlock = useMemo(() => {
    if (purchasedPages && purchasedPages.length > 0) {
      return purchasedPages.filter(p => getBlockIndexForPage(p) === activeBlock);
    }
    const range = getBlockPageRange(activeBlock, totalPages || numStreamPages);
    const pages: number[] = [];
    for (let p = range.startPage; p <= range.endPage; p++) {
      pages.push(p);
    }
    return pages;
  }, [purchasedPages, activeBlock, totalPages, numStreamPages]);

  // Determine next purchased block
  const nextPurchasedBlock = useMemo(() => {
    const curIdx = purchasedBlocksList.indexOf(activeBlock);
    if (curIdx >= 0 && curIdx + 1 < purchasedBlocksList.length) {
      return purchasedBlocksList[curIdx + 1];
    }
    return null;
  }, [purchasedBlocksList, activeBlock]);

  // Map original page number to stream PDF page index (1-based)
  const getPdfPageIndex = useCallback((originalPage: number): number => {
    if (purchasedPages && purchasedPages.length > 0) {
      const idx = purchasedPages.indexOf(originalPage);
      return idx >= 0 ? idx + 1 : 1;
    }
    return originalPage;
  }, [purchasedPages]);

  // Viewport Fit Scale computation
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
  const dpr = Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 3);

  // Arrival notification
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
      }
    } catch (err) {
      // offline fallback
    }
  }, [token, activeBlock]);

  // Handle page scrolling into view
  const handlePageVisible = useCallback((page: number) => {
    setCurrentPage(page);
    notifyArrival(page);
  }, [notifyArrival]);

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
        if (data.purchasedPages && Array.isArray(data.purchasedPages) && data.purchasedPages.length > 0) {
          setPurchasedPages(data.purchasedPages);
        }
        if (data.totalPages) {
          setTotalPages(data.totalPages);
        }
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
      // offline fallback
    }
  }, [token, currentPage]);

  useEffect(() => {
    syncServerSession();
  }, [syncServerSession]);

  // Master countdown timer interval (runs every 500ms)
  useEffect(() => {
    const timer = setInterval(() => {
      const nowMonotonic = getMonotonicNow();

      const bTimer = blockTimers[activeBlock];
      if (bTimer) {
        if (bTimer.isEligibleForNext) {
          setBlockRemainingSeconds(0);
        } else {
          const bRem = Math.max(0, Math.ceil((bTimer.eligibilityExpiresAt - nowMonotonic) / 1000));
          setBlockRemainingSeconds(bRem);
          if (bRem <= 0) {
            setBlockTimers(prev => ({
              ...prev,
              [activeBlock]: { ...prev[activeBlock], isEligibleForNext: true }
            }));
          }
        }
      }
      setTickerTime(nowMonotonic);
    }, 500);

    return () => clearInterval(timer);
  }, [activeBlock, blockTimers, getMonotonicNow]);

  // Load PDF Document Stream
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
          setNumStreamPages(doc.numPages);
          setLoadingPdf(false);

          // Measure page 1 dimensions for fit computation
          doc.getPage(1).then((p: any) => {
            const vp = p.getViewport({ scale: 1.0 });
            currentUnscaledDimRef.current = { width: vp.width, height: vp.height };
            updateFitScale();
          }).catch(() => {});
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
  }, [token, updateFitScale]);

  // Block print & save shortcuts (Ctrl+P, Cmd+P, Ctrl+S, Cmd+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (
        e.key === 'p' || e.key === 'P' ||
        e.key === 's' || e.key === 'S' ||
        e.key === 'u' || e.key === 'U'
      )) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === 'F12') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);

  // Pinch-to-Zoom Touch Handlers
  const touchStartRef = useRef<{ dist: number; zoom: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchStartRef.current = { dist, zoom: zoomMultiplier };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      if (e.cancelable) e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (touchStartRef.current.dist > 0) {
        const factor = dist / touchStartRef.current.dist;
        const newZoom = Math.max(0.5, Math.min(3.5, Number((touchStartRef.current.zoom * factor).toFixed(2))));
        setZoomMultiplier(newZoom);
      }
    }
  };

  const handleTouchEnd = () => {
    touchStartRef.current = null;
  };

  // Authoritative Navigation Handler
  const handleRequestNavigation = async (targetPage: number) => {
    if (targetPage < 1) return;

    // Strict purchased pages verification
    if (purchasedPages && purchasedPages.length > 0) {
      if (!purchasedPages.includes(targetPage)) {
        return;
      }
    }

    const targetBlock = getBlockIndexForPage(targetPage);
    const nowMonotonic = getMonotonicNow();

    // If targetPage is already inside the active block, scroll smoothly to it
    if (targetBlock === activeBlock) {
      setCurrentPage(targetPage);
      const targetEl = document.querySelector(`[data-page-num="${targetPage}"]`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    // Check backward navigation into previous blocks
    if (targetBlock < activeBlock) {
      const vb = visitedBlocks[targetBlock];
      if (!vb || nowMonotonic >= vb.graceExpiresAt) {
        return;
      }
    }

    // Moving forward into next block requires eligibility
    if (nextPurchasedBlock && targetBlock === nextPurchasedBlock) {
      const activeTimer = blockTimers[activeBlock];
      if (!activeTimer?.isEligibleForNext) {
        return;
      }
    } else if (targetBlock > activeBlock) {
      // Direct jump prohibited
      return;
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
      // Local fallback
      if (targetBlock < activeBlock) {
        const vb = visitedBlocks[targetBlock];
        if (vb && nowMonotonic < vb.graceExpiresAt) {
          setCurrentPage(targetPage);
        }
      } else if (targetBlock === nextPurchasedBlock && blockTimers[activeBlock]?.isEligibleForNext) {
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

  const isEligibleForNext = Boolean(blockTimers[activeBlock]?.isEligibleForNext);

  // Compute navigation button states
  const pageList = useMemo(() => {
    if (purchasedPages && purchasedPages.length > 0) {
      return purchasedPages;
    }
    const maxP = totalPages || numStreamPages || 1;
    return Array.from({ length: maxP }, (_, i) => i + 1);
  }, [purchasedPages, totalPages, numStreamPages]);

  const currentIdxInList = pageList.indexOf(currentPage);
  const prevPageNum = currentIdxInList > 0 ? pageList[currentIdxInList - 1] : null;
  const nextPageNum = currentIdxInList >= 0 && currentIdxInList + 1 < pageList.length ? pageList[currentIdxInList + 1] : null;

  const prevBlock = prevPageNum ? getBlockIndexForPage(prevPageNum) : null;
  const nextBlock = nextPageNum ? getBlockIndexForPage(nextPageNum) : null;

  const canGoPrev = Boolean(
    prevPageNum && (
      prevBlock === activeBlock ||
      Boolean(prevBlock && visitedBlocks[prevBlock] && tickerTime < visitedBlocks[prevBlock].graceExpiresAt)
    )
  );

  const canGoNext = Boolean(
    nextPageNum && (
      nextBlock === activeBlock ||
      (nextBlock === nextPurchasedBlock && isEligibleForNext) ||
      Boolean(nextBlock && visitedBlocks[nextBlock] && tickerTime < visitedBlocks[nextBlock].graceExpiresAt)
    )
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

      {/* Top Status & Controls Bar */}
      <div className="bg-slate-900 border-b border-slate-800 px-3 py-2 sm:px-4 sm:py-2.5 flex flex-wrap items-center justify-between gap-2.5 shrink-0 z-20 shadow-md">
        
        {/* Navigation & Dropdown Controls */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <button
            onClick={() => prevPageNum && handleRequestNavigation(prevPageNum)}
            disabled={!canGoPrev}
            className="min-h-[38px] px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs font-semibold"
            title={prevPageNum ? `Previous Page (${prevPageNum})` : "Start of document"}
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden xs:inline">Prev</span>
          </button>

          {/* Stable Page Selector Dropdown (Fixed: Zero Ticker Blinking) */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-300 hidden xs:inline">
              Page
            </span>
            <select
              value={currentPage}
              onChange={e => handleRequestNavigation(Number(e.target.value))}
              className="bg-slate-800 text-white text-[15px] sm:text-xs rounded-lg px-2.5 py-1.5 min-h-[38px] border border-slate-700 outline-none focus:border-[#00D26A] cursor-pointer"
            >
              {pageList.map(p => {
                const pBlock = getBlockIndexForPage(p);
                const isCurrentBlock = pBlock === activeBlock;
                const isPastBlock = pBlock < activeBlock;
                const isNextBlock = pBlock === nextPurchasedBlock;
                const isFutureLocked = pBlock > activeBlock && pBlock !== nextPurchasedBlock;

                let statusText = `Block ${pBlock}`;
                let disabled = false;

                if (isCurrentBlock) {
                  statusText = `Block ${pBlock} • Active`;
                  disabled = false;
                } else if (isPastBlock) {
                  const vb = visitedBlocks[pBlock];
                  if (vb && tickerTime < vb.graceExpiresAt) {
                    statusText = `Block ${pBlock} • Grace Period`;
                    disabled = false;
                  } else {
                    statusText = `Block ${pBlock} • Locked`;
                    disabled = true;
                  }
                } else if (isNextBlock) {
                  if (isEligibleForNext) {
                    statusText = `Block ${pBlock} • Eligible`;
                    disabled = false;
                  } else {
                    statusText = `Block ${pBlock} • Locked`;
                    disabled = true;
                  }
                } else if (isFutureLocked) {
                  statusText = `Block ${pBlock} • Locked`;
                  disabled = true;
                }

                return (
                  <option key={`opt-p-${p}`} value={p} disabled={disabled}>
                    Page {p} ({statusText})
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-slate-400">
              of {pageList.length}
            </span>
          </div>

          <button
            onClick={() => nextPageNum && handleRequestNavigation(nextPageNum)}
            disabled={!canGoNext}
            className="min-h-[38px] px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs font-semibold"
            title={nextPageNum ? `Next Page (${nextPageNum})` : "End of document"}
          >
            <span className="hidden xs:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Dynamic Timers & Zoom Controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          
          {/* Active Block Indicator */}
          <div className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 px-2.5 py-1 rounded-full text-blue-400 text-xs font-semibold whitespace-nowrap">
            <span>Block {activeBlock} ({authorizedPagesInActiveBlock.length} Pages)</span>
          </div>

          {/* Isolated Next Block Countdown Badge */}
          <BlockEligibilityBadge
            isEligibleForNext={isEligibleForNext}
            nextBlockNum={nextPurchasedBlock}
            remainingSeconds={blockRemainingSeconds}
          />

          {/* Isolated Visited Block Grace Badges */}
          <VisitedGraceBadges
            visitedBlocks={visitedBlocks}
            now={tickerTime}
          />

          {/* Zoom & Viewport Fit Controls */}
          <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-1 border border-slate-700">
            <button
              type="button"
              onClick={() => setZoomMultiplier(1.0)}
              className={`px-2 py-1 rounded text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1 ${
                zoomMultiplier === 1.0 ? 'bg-[#00D26A] text-slate-950 font-bold' : 'text-slate-300 hover:bg-slate-700'
              }`}
              title="Fit Page within Viewport"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Fit</span>
            </button>
            <button
              type="button"
              onClick={() => setZoomMultiplier(z => Math.max(+(z - 0.25).toFixed(2), 0.5))}
              className="p-1.5 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-medium text-slate-300 w-10 text-center">
              {zoomMultiplier === 1.0 ? 'Fit' : `${Math.round(zoomMultiplier * 100)}%`}
            </span>
            <button
              type="button"
              onClick={() => setZoomMultiplier(z => Math.min(+(z + 0.25).toFixed(2), 3.0))}
              className="p-1.5 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Viewport Container with Natural Vertical Page Scrolling & Pinch-to-Zoom */}
      <div 
        ref={containerRef}
        id="godrery-viewer-viewport"
        tabIndex={0}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: 'pan-x pan-y' }}
        className="flex-grow overflow-auto p-3 sm:p-6 relative z-0 focus:outline-none"
      >
        <div className="min-w-full min-h-full flex flex-col items-center justify-start gap-8 pb-12">
          
          {/* Render Authorized Pages of Current Block in Natural Vertical Sequence */}
          {authorizedPagesInActiveBlock.map((origP, idx) => (
            <PageCanvasItem
              key={`page-item-${origP}`}
              pdfDoc={pdfDoc}
              originalPage={origP}
              pdfPageIndex={getPdfPageIndex(origP)}
              effectiveScale={effectiveScale}
              dpr={dpr}
              isPrimary={idx === 0}
              onVisible={handlePageVisible}
            />
          ))}

          {/* Authorization Boundary Card at End of Block */}
          <div className="w-full max-w-md my-4 p-5 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-xl text-center">
            {isEligibleForNext && nextPurchasedBlock !== null ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Unlock className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white">Block {nextPurchasedBlock} Eligible to Enter</h3>
                  <p className="text-xs text-slate-400 mt-1">Your 5-minute reading period for Block {activeBlock} is satisfied.</p>
                </div>
                <button
                  onClick={() => {
                    const nextFirstPage = (purchasedPages && purchasedPages.length > 0)
                      ? purchasedPages.find(p => getBlockIndexForPage(p) === nextPurchasedBlock) || (nextPurchasedBlock - 1) * 4 + 1
                      : (nextPurchasedBlock - 1) * 4 + 1;
                    handleRequestNavigation(nextFirstPage);
                  }}
                  className="px-5 py-2.5 bg-[#00D26A] hover:bg-[#00b85c] text-slate-950 font-bold rounded-xl text-xs sm:text-sm transition-all shadow-lg flex items-center gap-2 cursor-pointer"
                >
                  <span>Enter Block {nextPurchasedBlock}</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            ) : nextPurchasedBlock !== null ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center">
                  <Lock className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white">End of Block {activeBlock}</h3>
                  <p className="text-xs text-slate-400 mt-1">Block {nextPurchasedBlock} unlocks when the active reading countdown expires.</p>
                </div>
                <div className="bg-rose-500/10 border border-rose-500/30 px-4 py-2 rounded-full text-rose-400 text-xs sm:text-sm font-semibold">
                  Next Block Unlocks In: <strong>{formatTime(blockRemainingSeconds)}</strong>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-slate-300">
                <CheckCircle2 className="w-8 h-8 text-[#00D26A]" />
                <h3 className="text-sm font-bold text-white">End of Purchased Document Pages</h3>
                <p className="text-xs text-slate-400">All purchased pages in your entitlement have been accessed.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// DocumentAccessView Shell with Verification
// -------------------------------------------------------------

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
  const [purchasedPages, setPurchasedPages] = useState<number[] | null>(null);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  
  const [isVerifying, setIsVerifying] = useState(false);

  useEffect(() => {
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
        if (data.purchasedPages) setPurchasedPages(data.purchasedPages);
        if (data.totalPages) setTotalPages(data.totalPages);
        setVerified(true);
      } else if (data.requireNames) {
        if (data.firstName) setCustomerFirstName(data.firstName);
        if (data.paperTitle) setPaperTitle(data.paperTitle);
        if (data.unitCode) setUnitCode(data.unitCode);
        if (data.purchasedPages) setPurchasedPages(data.purchasedPages);
        if (data.totalPages) setTotalPages(data.totalPages);
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
        if (data.purchasedPages) setPurchasedPages(data.purchasedPages);
        if (data.totalPages) setTotalPages(data.totalPages);
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
      <div className="w-full h-screen bg-[#052b1b] flex flex-col overflow-hidden">
        {/* Customer Welcome Header */}
        <div className="w-full bg-[#031d12] border-b border-slate-800 px-3 py-2.5 sm:px-6 sm:py-3 flex flex-wrap items-center justify-between gap-2.5 shadow-sm shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#00D26A]/20 text-[#00D26A] flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-[11px] sm:text-xs font-semibold text-[#00D26A] tracking-wider uppercase">
                  Welcome, {customerFirstName || 'Customer'}
                </span>
                {unitCode && (
                  <span className="text-[10px] bg-slate-800 text-slate-300 font-mono px-1.5 py-0.5 rounded border border-slate-700">
                    {unitCode}
                  </span>
                )}
              </div>
              <h1 className="text-xs sm:text-base font-bold text-white tracking-tight leading-tight line-clamp-1">
                {paperTitle || 'Protected Document'}
              </h1>
            </div>
          </div>
          <button 
            onClick={() => window.location.href = '/'} 
            className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer py-1.5 px-2.5 sm:px-3 rounded-lg bg-slate-800 hover:bg-slate-700 min-h-[36px]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden xs:inline">Return to Home</span>
          </button>
        </div>
        <PdfCanvasViewer 
          token={token} 
          initialCustomerFirstName={customerFirstName}
          initialPaperTitle={paperTitle}
          initialUnitCode={unitCode}
          initialPurchasedPages={purchasedPages}
          initialTotalPages={totalPages}
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
