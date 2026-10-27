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
  Hourglass,
  CheckCircle2,
  Printer,
  Maximize2 
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

// Configure worker src for pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

const OVERALL_SESSION_DURATION_MS = 600 * 1000; // 10 minutes (600 seconds)
const NEW_PAGE_READING_DURATION_MS = 120 * 1000; // 2 minutes (120 seconds)
const REVISIT_TRANSITION_DURATION_MS = 60 * 1000; // 1 minute (60 seconds)

interface PageReadingState {
  firstOpenedAt: number;
  readingExpiresAt: number;
  isCompleted: boolean;
  hasArrived?: boolean;
}

interface ActiveTransitionState {
  destinationPage: number;
  expiresAt: number;
}

interface PersistedSessionState {
  overallExpiresAt: number;
  visitedPages: number[];
  currentPage: number;
  pageReadingTimers: Record<number, PageReadingState>;
  activeTransition: ActiveTransitionState | null;
  savedAt: number;
}

function getStoredSession(token: string): PersistedSessionState | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const raw = window.sessionStorage.getItem(`godrery_session_${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.overallExpiresAt === 'number') {
      return parsed as PersistedSessionState;
    }
  } catch (e) {
    // ignore parse error
  }
  return null;
}

function saveStoredSession(token: string, state: Omit<PersistedSessionState, 'savedAt'>) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(`godrery_session_${token}`, JSON.stringify({
      ...state,
      savedAt: Date.now()
    }));
  } catch (e) {
    // ignore write error
  }
}

function PdfCanvasViewer({ token }: { token: string }) {
  const initialSaved = useRef(getStoredSession(token)).current;
  const now = Date.now();
  const isInitialExpired = Boolean(initialSaved && initialSaved.overallExpiresAt <= now);

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState<number>(() => {
    if (initialSaved && !isInitialExpired && typeof initialSaved.currentPage === 'number') {
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

  // Overall 10-minute viewing session expiry
  const [overallExpiresAt, setOverallExpiresAt] = useState<number>(() => {
    if (initialSaved && !isInitialExpired) {
      return initialSaved.overallExpiresAt;
    }
    return now + OVERALL_SESSION_DURATION_MS;
  });
  const [overallRemainingSeconds, setOverallRemainingSeconds] = useState<number>(() => {
    if (initialSaved && !isInitialExpired) {
      return Math.max(0, Math.floor((initialSaved.overallExpiresAt - now) / 1000));
    }
    return 600;
  });
  const [overallSessionExpired, setOverallSessionExpired] = useState(isInitialExpired);

  // Visited pages set (Page 1 welcome page is always visited initially)
  const [visitedPages, setVisitedPages] = useState<number[]>(() => {
    if (initialSaved && !isInitialExpired && Array.isArray(initialSaved.visitedPages)) {
      return initialSaved.visitedPages;
    }
    return [1];
  });

  // Page reading timer state
  // Welcome page (1) is free: readingExpiresAt <= now, isCompleted = true, hasArrived = true
  const [pageReadingTimers, setPageReadingTimers] = useState<Record<number, PageReadingState>>(() => {
    if (initialSaved && !isInitialExpired && initialSaved.pageReadingTimers) {
      const timers = { ...initialSaved.pageReadingTimers };
      for (const [p, t] of Object.entries(timers)) {
        if (t && !t.isCompleted && t.hasArrived && now >= t.readingExpiresAt) {
          timers[Number(p)] = { ...t, isCompleted: true };
        }
      }
      return timers;
    }
    return {
      1: { firstOpenedAt: now, readingExpiresAt: now, isCompleted: true, hasArrived: true }
    };
  });
  const [pageReadingRemainingSeconds, setPageReadingRemainingSeconds] = useState<number>(() => {
    if (initialSaved && !isInitialExpired) {
      const curP = initialSaved.currentPage || 1;
      const curTimer = initialSaved.pageReadingTimers?.[curP];
      if (curTimer && !curTimer.isCompleted && curTimer.hasArrived) {
        return Math.max(0, Math.ceil((curTimer.readingExpiresAt - now) / 1000));
      }
    }
    return 0;
  });

  // One-minute navigation transition gate
  const [activeTransition, setActiveTransition] = useState<ActiveTransitionState | null>(() => {
    if (initialSaved && !isInitialExpired && initialSaved.activeTransition) {
      if (now < initialSaved.activeTransition.expiresAt) {
        return initialSaved.activeTransition;
      }
    }
    return null;
  });
  const [transitionRemainingSeconds, setTransitionRemainingSeconds] = useState<number>(() => {
    if (initialSaved && !isInitialExpired && initialSaved.activeTransition) {
      return Math.max(0, Math.ceil((initialSaved.activeTransition.expiresAt - now) / 1000));
    }
    return 0;
  });

  // Persist session to sessionStorage on state changes
  useEffect(() => {
    if (overallSessionExpired) {
      try {
        window.sessionStorage.removeItem(`godrery_session_${token}`);
      } catch {}
      return;
    }
    saveStoredSession(token, {
      overallExpiresAt,
      visitedPages,
      currentPage,
      pageReadingTimers,
      activeTransition
    });
  }, [token, overallExpiresAt, visitedPages, currentPage, pageReadingTimers, activeTransition, overallSessionExpired]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const currentUnscaledDimRef = useRef<{ width: number; height: number } | null>(null);

  // Monotonic client clock anchor to resist local wall-clock shifts and sustain offline countdowns
  const timeAnchorRef = useRef<{ perfNow: number; wallNow: number }>({
    perfNow: typeof performance !== 'undefined' ? performance.now() : 0,
    wallNow: Date.now()
  });

  const getMonotonicNow = useCallback(() => {
    if (typeof performance === 'undefined') return Date.now();
    const elapsed = performance.now() - timeAnchorRef.current.perfNow;
    return timeAnchorRef.current.wallNow + elapsed;
  }, []);

  // Viewport Fit Scale computation
  const updateFitScale = useCallback(() => {
    if (!containerRef.current || !currentUnscaledDimRef.current) return;
    const container = containerRef.current;
    const availW = Math.max(container.clientWidth - 32, 200);
    const availH = Math.max(container.clientHeight - 32, 200);
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

  // Arrival notification: sends arrival confirmation to server when page finishes rendering
  const notifyArrival = useCallback(async (pageNum: number) => {
    if (pageNum === 1) return; // Welcome page is free
    try {
      const res = await fetch(`/api/document/session/${token}/arrive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: pageNum })
      });
      const data = await res.json();
      if (data.success && data.arrived) {
        setPageReadingTimers(prev => {
          const existing = prev[pageNum];
          return {
            ...prev,
            [pageNum]: {
              firstOpenedAt: existing?.firstOpenedAt || Date.now(),
              readingExpiresAt: data.expiresAt,
              isCompleted: data.remainingSeconds <= 0,
              hasArrived: true
            }
          };
        });
        setPageReadingRemainingSeconds(data.remainingSeconds);
      }
    } catch (err) {
      // Offline fallback: start monotonic countdown if not already started
      setPageReadingTimers(prev => {
        if (prev[pageNum]?.hasArrived) return prev;
        const now = getMonotonicNow();
        return {
          ...prev,
          [pageNum]: {
            firstOpenedAt: now,
            readingExpiresAt: now + NEW_PAGE_READING_DURATION_MS,
            isCompleted: false,
            hasArrived: true
          }
        };
      });
    }
  }, [token, getMonotonicNow]);

  // Determine if page-changing inputs should be locked
  const currentTimer = pageReadingTimers[currentPage];
  const nowForLock = getMonotonicNow();
  const isPageReadingActive = Boolean(currentTimer && !currentTimer.isCompleted && nowForLock < currentTimer.readingExpiresAt);
  const isTransitionActive = Boolean(activeTransition && nowForLock < activeTransition.expiresAt);
  const isNavigationLocked = isPageReadingActive || isTransitionActive || overallSessionExpired;

  // Sync session state from server
  const syncServerSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/document/session/${token}`);
      if (res.status === 403) {
        setOverallSessionExpired(true);
        return;
      }
      const data = await res.json();
      if (data.success) {
        timeAnchorRef.current = {
          perfNow: typeof performance !== 'undefined' ? performance.now() : 0,
          wallNow: Date.now()
        };
        if (data.overallExpiresAt) {
          setOverallExpiresAt(data.overallExpiresAt);
          const rem = Math.max(0, Math.floor((data.overallExpiresAt - Date.now()) / 1000));
          setOverallRemainingSeconds(rem);
          if (rem <= 0) setOverallSessionExpired(true);
        }
        if (Array.isArray(data.visitedPages)) {
          setVisitedPages(data.visitedPages);
        }
        if (data.currentPage && data.currentPage !== currentPage) {
          setCurrentPage(data.currentPage);
        }
        if (data.pageTimer) {
          setPageReadingTimers(prev => ({
            ...prev,
            [data.pageTimer.currentPage]: {
              firstOpenedAt: prev[data.pageTimer.currentPage]?.firstOpenedAt || Date.now(),
              readingExpiresAt: data.pageTimer.readingExpiresAt,
              isCompleted: data.pageTimer.isCompleted,
              hasArrived: true
            }
          }));
        }
        if (data.activeTransition) {
          setActiveTransition({
            destinationPage: data.activeTransition.destinationPage,
            expiresAt: data.activeTransition.expiresAt
          });
        }
      }
    } catch (e) {
      // offline / network error - monotonic timer continues locally
    }
  }, [token, currentPage]);

  // Initial session sync
  useEffect(() => {
    syncServerSession();
  }, [syncServerSession]);

  // Revalidate with server when network connectivity returns or tab regains visibility
  useEffect(() => {
    const handleOnline = () => {
      syncServerSession();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncServerSession();
      }
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncServerSession]);

  // Master countdown timer interval (runs every 500ms for smooth, accurate timestamps)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = getMonotonicNow();

      // 1. Overall session expiry
      const overallRem = Math.max(0, Math.floor((overallExpiresAt - now) / 1000));
      setOverallRemainingSeconds(overallRem);
      if (overallRem <= 0) {
        setOverallSessionExpired(true);
      }

      // 2. Current page reading countdown
      const pTimer = pageReadingTimers[currentPage];
      if (pTimer && !pTimer.isCompleted) {
        const pageRem = Math.max(0, Math.ceil((pTimer.readingExpiresAt - now) / 1000));
        setPageReadingRemainingSeconds(pageRem);
        if (pageRem <= 0) {
          setPageReadingTimers(prev => ({
            ...prev,
            [currentPage]: { ...prev[currentPage], isCompleted: true }
          }));
        }
      } else {
        setPageReadingRemainingSeconds(0);
      }

      // 3. Active 1-minute transition countdown
      if (activeTransition) {
        const transRem = Math.max(0, Math.ceil((activeTransition.expiresAt - now) / 1000));
        setTransitionRemainingSeconds(transRem);
        if (transRem <= 0) {
          // Complete transition automatically!
          const dest = activeTransition.destinationPage;
          setActiveTransition(null);
          setCurrentPage(dest);

          // Notify server of completed transition
          fetch(`/api/document/session/${token}/complete-transition`, {
            method: 'POST'
          }).catch(() => {});
        }
      } else {
        setTransitionRemainingSeconds(0);
      }
    }, 500);

    return () => clearInterval(timer);
  }, [overallExpiresAt, currentPage, pageReadingTimers, activeTransition, token, getMonotonicNow]);

  // Load PDF Document
  useEffect(() => {
    let isMounted = true;
    const loadPdf = async () => {
      try {
        const res = await fetch(`/api/document/stream/${token}`);
        if (!res.ok) {
          if (res.status === 403) {
            setOverallSessionExpired(true);
            return;
          }
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

  // Block page-changing keyboard shortcuts when navigation is locked
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const pageKeys = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '];
      if (pageKeys.includes(e.key)) {
        if (isNavigationLocked) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isNavigationLocked]);

  // Navigation Handler
  const handleRequestNavigation = async (targetPage: number) => {
    if (isNavigationLocked) return;
    if (targetPage === currentPage || targetPage < 1 || targetPage > numPages) return;

    const now = Date.now();
    const isVisited = visitedPages.includes(targetPage);

    // Call server navigation endpoint for authoritative check
    try {
      const res = await fetch(`/api/document/session/${token}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPage })
      });
      const data = await res.json();

      if (!data.success) {
        if (data.error === 'page_reading_active') {
          setPageReadingRemainingSeconds(data.remainingSeconds || 10);
        }
        return;
      }

      if (data.transitioning) {
        // Start 1-minute navigation gate
        setActiveTransition({
          destinationPage: targetPage,
          expiresAt: data.expiresAt || (now + 60 * 1000)
        });
        setTransitionRemainingSeconds(data.remainingSeconds || 60);
      } else if (data.navigated) {
        // Navigated to new page
        setCurrentPage(targetPage);
        setVisitedPages(prev => Array.from(new Set([...prev, targetPage])));
        
        if (targetPage === 1) {
          setPageReadingTimers(prev => ({
            ...prev,
            1: { firstOpenedAt: now, readingExpiresAt: now, isCompleted: true, hasArrived: true }
          }));
          setPageReadingRemainingSeconds(0);
        } else {
          // Waiting for arrival event when page canvas finishes rendering
          setPageReadingTimers(prev => ({
            ...prev,
            [targetPage]: prev[targetPage] || {
              firstOpenedAt: now,
              readingExpiresAt: now + NEW_PAGE_READING_DURATION_MS,
              isCompleted: false,
              hasArrived: false
            }
          }));
          setPageReadingRemainingSeconds(120);
        }
      }
    } catch (e) {
      // Local fallback in case of transient offline
      if (isVisited) {
        setActiveTransition({
          destinationPage: targetPage,
          expiresAt: now + REVISIT_TRANSITION_DURATION_MS
        });
        setTransitionRemainingSeconds(60);
      } else {
        setCurrentPage(targetPage);
        setVisitedPages(prev => Array.from(new Set([...prev, targetPage])));
        if (targetPage === 1) {
          setPageReadingTimers(prev => ({
            ...prev,
            1: { firstOpenedAt: now, readingExpiresAt: now, isCompleted: true, hasArrived: true }
          }));
          setPageReadingRemainingSeconds(0);
        } else {
          setPageReadingTimers(prev => ({
            ...prev,
            [targetPage]: prev[targetPage] || {
              firstOpenedAt: now,
              readingExpiresAt: now + NEW_PAGE_READING_DURATION_MS,
              isCompleted: false,
              hasArrived: false
            }
          }));
          setPageReadingRemainingSeconds(120);
        }
      }
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  // Expired Screen
  if (overallSessionExpired) {
    return (
      <div className="flex-grow w-full h-full flex items-center justify-center bg-slate-950 p-6 text-center">
        <div className="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-4 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
            <Clock className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-white">Viewing Session Expired</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            Your 10-minute secure viewing session has ended. To continue reading, please reopen the document from your secure email link.
          </p>
          <button
            onClick={() => window.location.href = '/'}
            className="w-full py-3 bg-[#00D26A] hover:bg-[#00b85c] text-white font-bold rounded-xl transition-all cursor-pointer"
          >
            Return to Home
          </button>
        </div>
      </div>
    );
  }

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
            disabled={isNavigationLocked || currentPage <= 1}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
            title={
              isNavigationLocked 
                ? "Navigation locked while timer is active" 
                : currentPage > 1 && visitedPages.includes(currentPage - 1)
                  ? `Revisit Page ${currentPage - 1} (Requires 1-min gate)`
                  : `Previous Page`
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
              disabled={isNavigationLocked}
              onChange={e => handleRequestNavigation(Number(e.target.value))}
              className="bg-slate-800 text-white text-xs rounded-lg px-2 py-1 border border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:border-[#00D26A]"
            >
              {Array.from({ length: numPages }, (_, i) => i + 1).map(p => {
                const isVisited = visitedPages.includes(p);
                return (
                  <option key={p} value={p}>
                    {p} {p === 1 ? '(Welcome)' : isVisited ? '(Visited • 1-min gate)' : '(New • 2-min timer)'}
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-slate-400">of {numPages}</span>
          </div>

          <button
            onClick={() => handleRequestNavigation(currentPage + 1)}
            disabled={isNavigationLocked || currentPage >= numPages}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
            title={
              isNavigationLocked 
                ? "Navigation locked while timer is active" 
                : currentPage < numPages && visitedPages.includes(currentPage + 1)
                  ? `Revisit Page ${currentPage + 1} (Requires 1-min gate)`
                  : `Next: Page ${currentPage + 1} (Starts 2-min countdown)`
            }
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Dynamic Timers and Reading Status */}
        <div className="flex flex-wrap items-center gap-3">
          
          {/* Per-Page Reading Timer Badge */}
          {currentPage === 1 ? (
            <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full text-emerald-400 text-xs font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Welcome Page (Free Access)</span>
            </div>
          ) : isPageReadingActive ? (
            <div className="flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/30 px-3 py-1 rounded-full text-rose-400 text-xs font-medium animate-pulse">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>Page {currentPage} Reading: <strong>{formatTime(pageReadingRemainingSeconds)}</strong> (Locked)</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full text-emerald-400 text-xs font-medium">
              <Unlock className="w-3.5 h-3.5 shrink-0" />
              <span>Page {currentPage} Complete (Unlocked)</span>
            </div>
          )}

          {/* Overall 10-Minute Session Timer */}
          <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full text-amber-400 text-xs font-medium">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Overall Session: <strong>{formatTime(overallRemainingSeconds)}</strong></span>
          </div>

          {/* Zoom & Viewport Fit Controls (Always interactive during reading!) */}
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

          {/* Single-Page Print Control */}
          <button
            type="button"
            onClick={() => window.print()}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
            title="Print Active Page Only"
          >
            <Printer className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">Print Page</span>
          </button>
        </div>
      </div>

      {/* Active One-Minute Transition Gate Banner */}
      {isTransitionActive && activeTransition && (
        <div className="bg-amber-600/90 text-white px-4 py-2 flex items-center justify-between text-xs font-semibold z-20 shadow-lg animate-in slide-in-from-top duration-300">
          <div className="flex items-center gap-2">
            <Hourglass className="w-4 h-4 animate-spin shrink-0 text-amber-200" />
            <span>
              1-Minute Navigation Gate: Opening previously visited Page {activeTransition.destinationPage} in{' '}
              <strong>{formatTime(transitionRemainingSeconds)}</strong>. All navigation changes are locked.
            </span>
          </div>
          <span className="bg-amber-900/40 px-2 py-0.5 rounded text-[11px] font-mono">
            {transitionRemainingSeconds}s remaining
          </span>
        </div>
      )}

      {/* Scoped Single-Page Print CSS */}
      <style>{`
        @media print {
          @page {
            size: auto;
            margin: 10mm;
          }
          body {
            visibility: hidden !important;
            background: white !important;
          }
          #godrery-print-wrapper,
          #godrery-print-wrapper * {
            visibility: visible !important;
          }
          #godrery-print-wrapper {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: white !important;
            margin: 0 !important;
            padding: 0 !important;
            z-index: 999999 !important;
          }
          #godrery-active-canvas {
            max-width: 100% !important;
            max-height: 100% !important;
            width: auto !important;
            height: auto !important;
            box-shadow: none !important;
            border: none !important;
            display: block !important;
          }
          .godrery-print-watermark {
            display: block !important;
            visibility: visible !important;
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) rotate(-35deg) !important;
            font-size: 24pt !important;
            font-weight: 900 !important;
            color: rgba(0, 0, 0, 0.12) !important;
            white-space: nowrap !important;
            pointer-events: none !important;
            letter-spacing: 2px !important;
            z-index: 1000000 !important;
          }
        }
      `}</style>

      {/* Canvas Container with Auto-Fit Viewport & Disabled Context Menu */}
      <div 
        ref={containerRef}
        className="flex-grow overflow-auto flex items-center justify-center p-4 relative z-0"
        onWheel={e => {
          // Block page scrolling / gestures from switching pages
          if (isNavigationLocked && e.ctrlKey) {
            // allow pinch zoom if browser supports
          }
        }}
      >
        <div 
          id="godrery-print-wrapper"
          className="shadow-2xl bg-white rounded-lg overflow-hidden border border-slate-700 relative min-w-[200px] min-h-[200px]"
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
          <div className="godrery-print-watermark hidden">
            GODRERY PUBLISHERS • PAGE {currentPage} OF {numPages} • SINGLE PAGE PRINT
          </div>
          <canvas 
            id="godrery-active-canvas"
            ref={canvasRef} 
            className="block shadow-lg" 
          />
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
        setVerified(true);
      } else if (data.requireNames) {
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
        <div className="w-full bg-[#031d12] border-b border-slate-800 p-3 sm:px-6 flex items-center justify-between shadow-sm shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#00D26A]/20 text-[#00D26A] flex items-center justify-center">
              <Shield className="w-4 h-4" />
            </div>
            <h1 className="text-sm font-bold text-white tracking-wide">Secure Document Access (Godrery Publishers)</h1>
          </div>
          <button 
            onClick={() => window.location.href = '/'} 
            className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Home</span>
          </button>
        </div>
        <PdfCanvasViewer token={token} />
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
