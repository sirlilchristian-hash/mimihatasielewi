import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  X, 
  FileText, 
  Download, 
  CheckCircle2, 
  RotateCw, 
  Loader2, 
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { Paper } from './adminTypes';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

interface AdminPaperViewerModalProps {
  paper: Paper | null;
  onClose: () => void;
  onRequestDownload: (paper: Paper) => void;
}

export const AdminPaperViewerModal: React.FC<AdminPaperViewerModalProps> = ({
  paper,
  onClose,
  onRequestDownload,
}) => {
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTrigger, setReloadTrigger] = useState<number>(0);

  const [zoomMultiplier, setZoomMultiplier] = useState<number>(1.0);
  const [baseFitScale, setBaseFitScale] = useState<number>(1.0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);
  const unscaledDimRef = useRef<{ width: number; height: number } | null>(null);

  const updateFitScale = useCallback(() => {
    if (!containerRef.current || !unscaledDimRef.current) return;
    const container = containerRef.current;
    const availW = Math.max(container.clientWidth - 40, 200);
    const availH = Math.max(container.clientHeight - 40, 200);
    const { width, height } = unscaledDimRef.current;
    if (width > 0 && height > 0) {
      setBaseFitScale(Math.min(availW / width, availH / height));
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => updateFitScale());
    observer.observe(container);
    window.addEventListener('resize', updateFitScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateFitScale);
    };
  }, [updateFitScale]);

  const effectiveScale = (baseFitScale || 1.0) * zoomMultiplier;

  // Load PDF ArrayBuffer
  useEffect(() => {
    if (!paper) {
      setPdfDoc(null);
      setTotalPages(0);
      return;
    }

    let isMounted = true;

    async function loadPdf() {
      setIsLoading(true);
      setError(null);
      setCurrentPage(1);

      try {
        let arrayBuffer: ArrayBuffer;

        if (paper.localFile && paper.localFile instanceof File) {
          arrayBuffer = await paper.localFile.arrayBuffer();
        } else if (!paper.id || paper.id === 'DRAFT' || paper.id.startsWith('paper-')) {
          setIsLoading(false);
          setError('No document file attached to preview. Please select a PDF document or save the paper first.');
          return;
        } else {
          const token = localStorage.getItem('admin_token');
          const res = await fetch(`/api/admin/papers/${paper.id}/preview?t=${Date.now()}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            cache: 'no-store',
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to fetch document from repository (HTTP ${res.status})`);
          }

          arrayBuffer = await res.arrayBuffer();
        }

        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const doc = await loadingTask.promise;

        if (isMounted) {
          setPdfDoc(doc);
          setTotalPages(doc.numPages);
          setIsLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('Error loading PDF preview:', err);
          setError(err.message || 'Unable to preview examination paper PDF.');
          setIsLoading(false);
        }
      }
    }

    loadPdf();

    return () => {
      isMounted = false;
    };
  }, [paper?.id, paper?.file_path, reloadTrigger]);

  // Render single page onto canvas
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
      unscaledDimRef.current = { width: unscaledViewport.width, height: unscaledViewport.height };
      updateFitScale();

      const viewport = page.getViewport({ scale: effectiveScale });
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
      };

      const renderTask = page.render(renderContext);
      renderTaskRef.current = renderTask;
      renderTask.promise.catch((err: any) => {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Page render error:', err);
        }
      });
    });

    return () => {
      isCancelled = true;
    };
  }, [pdfDoc, currentPage, effectiveScale, updateFitScale]);

  if (!paper) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 overflow-hidden">
      <div className="bg-slate-900 border border-slate-800 text-slate-100 rounded-3xl w-full max-w-5xl h-[94vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header Bar */}
        <div className="px-6 py-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[#00D26A]/20 text-[#00D26A] flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-[#00D26A]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="bg-[#00D26A] text-slate-950 px-2 py-0.5 rounded font-mono font-black text-xs">
                  {paper.unit_code}
                </span>
                <h3 className="text-sm sm:text-base font-extrabold text-white truncate">
                  {paper.paper_title}
                </h3>
              </div>
              <p className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2 mt-0.5 font-mono">
                <span className="text-slate-300 font-semibold truncate max-w-md" title={paper.file_path}>
                  File: {paper.file_path || `${paper.unit_code}_Exam.pdf`}
                </span>
                <span>•</span>
                <span>Status: {paper.status || 'available'}</span>
                <span>•</span>
                <span className="text-emerald-400 font-bold">Price: {paper.price || 'KSh 50'}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setReloadTrigger((prev) => prev + 1)}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
              title="Refresh Preview from Storage"
            >
              <RotateCw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onRequestDownload(paper)}
              className="hidden sm:flex px-3.5 py-2 bg-[#00D26A] hover:bg-[#00b85c] text-slate-950 font-black text-xs rounded-xl items-center gap-1.5 shadow transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Page Toolbar with Pure Canvas Controls (No Native Plugin, No Facing/Two-Page Mode) */}
        <div className="px-6 py-2.5 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300 shrink-0">
          <div className="flex items-center gap-3">
            {/* Page Navigation */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1 || isLoading}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
                title="Previous Page"
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Prev</span>
              </button>

              <div className="flex items-center gap-1.5 font-mono">
                <span>Page</span>
                <select
                  value={currentPage}
                  onChange={(e) => setCurrentPage(Number(e.target.value))}
                  disabled={isLoading || totalPages <= 1}
                  className="bg-slate-800 text-white text-xs rounded-lg px-2 py-1 border border-slate-700 disabled:opacity-50 outline-none focus:border-[#00D26A]"
                >
                  {Array.from({ length: totalPages || 1 }, (_, i) => i + 1).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className="text-slate-400">of {totalPages || 1}</span>
              </div>

              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages || isLoading}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors cursor-pointer flex items-center gap-1 text-xs"
                title="Next Page"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-1">
              <button
                type="button"
                onClick={() => setZoomMultiplier(1.0)}
                className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1 ${
                  zoomMultiplier === 1.0 ? 'bg-[#00D26A] text-slate-950 font-bold' : 'text-slate-300 hover:bg-slate-700'
                }`}
                title="Fit Page within Viewport"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Fit</span>
              </button>
              <button
                type="button"
                onClick={() => setZoomMultiplier((z) => Math.max(+(z - 0.25).toFixed(2), 0.5))}
                className="p-1 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono text-slate-300 w-12 text-center">
                {zoomMultiplier === 1.0 ? 'Fit' : `${Math.round(zoomMultiplier * 100)}%`}
              </span>
              <button
                type="button"
                onClick={() => setZoomMultiplier((z) => Math.min(+(z + 0.25).toFixed(2), 3.0))}
                className="p-1 rounded hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
            {isLoading ? (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Loading document...</span>
              </span>
            ) : error ? (
              <span className="flex items-center gap-1.5 text-rose-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Preview Error</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-emerald-400 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#00D26A]" />
                <span>Single-Page Canvas Preview ({totalPages} {totalPages === 1 ? 'Page' : 'Pages'})</span>
              </span>
            )}
            <span className="hidden sm:inline">•</span>
            <span className="hidden sm:inline">Encrypted Vault Storage</span>
          </div>
        </div>

        {/* Document Rendering via Pure Single-Page HTML5 Canvas */}
        <div 
          ref={containerRef}
          className="flex-1 bg-slate-950 p-3 sm:p-6 overflow-auto flex flex-col justify-center items-center relative select-none"
          onContextMenu={(e) => e.preventDefault()}
        >
          {isLoading && (
            <div className="flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 text-[#00D26A] animate-spin" />
              <p className="text-sm font-mono">Fetching document from private storage repository...</p>
            </div>
          )}

          {!isLoading && error && (
            <div className="max-w-md p-6 bg-rose-950/40 border border-rose-800/60 rounded-2xl text-center space-y-3">
              <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Document Preview Unavailable</h4>
              <p className="text-xs text-rose-200 font-mono leading-relaxed">{error}</p>
              <button
                type="button"
                onClick={() => setReloadTrigger((prev) => prev + 1)}
                className="px-4 py-2 bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold rounded-xl transition-colors inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Retry Fetch</span>
              </button>
            </div>
          )}

          {!isLoading && !error && (
            <div className="shadow-2xl bg-white rounded-lg overflow-hidden border border-slate-700 relative">
              <canvas ref={canvasRef} className="block shadow-lg" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
