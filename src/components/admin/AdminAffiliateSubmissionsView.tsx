import React, { useState, useEffect } from 'react';
import {
  UploadCloud,
  Search,
  ExternalLink,
  MessageCircle,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Save,
  Database,
  X,
  XCircle,
  Eye,
  RefreshCw,
  Building,
  DollarSign,
} from 'lucide-react';
import { AffiliateSubmissionAdminRecord } from './adminTypes';

interface AdminAffiliateSubmissionsViewProps {
  adminRole: string;
  initialSelectedId?: string | null;
  onPaperPushed?: () => void;
}

export const AdminAffiliateSubmissionsView: React.FC<AdminAffiliateSubmissionsViewProps> = ({
  adminRole,
  initialSelectedId = null,
  onPaperPushed,
}) => {
  const [submissions, setSubmissions] = useState<AffiliateSubmissionAdminRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'under_review' | 'approved' | 'rejected'>('all');

  // Modal State
  const [activeSubmission, setActiveSubmission] = useState<AffiliateSubmissionAdminRecord | null>(null);
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [isPushingPaper, setIsPushingPaper] = useState(false);
  const [modalSuccessMsg, setModalSuccessMsg] = useState<string | null>(null);
  const [modalErrorMsg, setModalErrorMsg] = useState<string | null>(null);

  // Editable fields in modal
  const [editTitle, setEditTitle] = useState('');
  const [editUnitCode, setEditUnitCode] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editAcademicLevel, setEditAcademicLevel] = useState('');
  const [editPrice, setEditPrice] = useState('30');
  const [editDescription, setEditDescription] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  const fetchSubmissions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/affiliate-submissions', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) {
        throw new Error('Failed to load affiliate submissions.');
      }
      const data = await res.json();
      setSubmissions(data);

      // Deep link selection
      if (initialSelectedId) {
        const found = data.find(
          (s: AffiliateSubmissionAdminRecord) =>
            s.id === initialSelectedId || s.reference_code === initialSelectedId
        );
        if (found) {
          openReviewModal(found);
        }
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error loading affiliate submissions.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSubmissions();
  }, [initialSelectedId]);

  const openReviewModal = (sub: AffiliateSubmissionAdminRecord) => {
    setActiveSubmission(sub);
    setEditTitle(sub.paper_title || '');
    setEditUnitCode(sub.unit_code || '');
    setEditCategory(sub.category || 'Past Examination Papers');
    setEditAcademicLevel(sub.academic_level || 'Undergraduate Degree');
    setEditPrice((sub.price !== undefined ? sub.price : 30).toString());
    setEditDescription(sub.description || '');
    setRejectionReason(sub.rejection_reason || '');
    setShowRejectInput(false);
    setModalSuccessMsg(null);
    setModalErrorMsg(null);
  };

  const closeReviewModal = () => {
    setActiveSubmission(null);
    setModalSuccessMsg(null);
    setModalErrorMsg(null);
  };

  // Save metadata changes without importing
  const handleSaveEdits = async () => {
    if (!activeSubmission) return;
    setIsSavingEdits(true);
    setModalSuccessMsg(null);
    setModalErrorMsg(null);

    try {
      const res = await fetch(`/api/admin/affiliate-submissions/${activeSubmission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper_title: editTitle,
          unit_code: editUnitCode,
          category: editCategory,
          academic_level: editAcademicLevel,
          price: parseInt(editPrice, 10) || 30,
          description: editDescription,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update metadata.');
      }

      setModalSuccessMsg('Paper metadata saved successfully (not yet imported).');
      setActiveSubmission(data.submission);
      setSubmissions((prev) =>
        prev.map((s) => (s.id === data.submission.id ? data.submission : s))
      );
    } catch (err: any) {
      setModalErrorMsg(err.message || 'Error saving edits.');
    } finally {
      setIsSavingEdits(false);
    }
  };

  // Reject submission
  const handleRejectSubmission = async () => {
    if (!activeSubmission) return;
    if (!rejectionReason.trim()) {
      setModalErrorMsg('Please provide a reason for rejection.');
      return;
    }

    setIsSavingEdits(true);
    setModalSuccessMsg(null);
    setModalErrorMsg(null);

    try {
      const res = await fetch(`/api/admin/affiliate-submissions/${activeSubmission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'rejected',
          rejection_reason: rejectionReason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reject submission.');
      }

      setModalSuccessMsg('Submission marked as rejected.');
      setActiveSubmission(data.submission);
      setSubmissions((prev) =>
        prev.map((s) => (s.id === data.submission.id ? data.submission : s))
      );
      setShowRejectInput(false);
    } catch (err: any) {
      setModalErrorMsg(err.message || 'Error rejecting submission.');
    } finally {
      setIsSavingEdits(false);
    }
  };

  // Explicit PUSH TO PAPERS DATABASE
  const handlePushToPapers = async () => {
    if (!activeSubmission) return;
    if (activeSubmission.status === 'approved' || activeSubmission.imported_paper_id) {
      setModalErrorMsg('This paper has already been imported into the Papers database.');
      return;
    }

    // Save latest metadata first if dirty
    setIsPushingPaper(true);
    setModalSuccessMsg(null);
    setModalErrorMsg(null);

    try {
      // Step 1: Save metadata edits first
      await fetch(`/api/admin/affiliate-submissions/${activeSubmission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper_title: editTitle,
          unit_code: editUnitCode,
          category: editCategory,
          academic_level: editAcademicLevel,
          price: parseInt(editPrice, 10) || 30,
          description: editDescription,
        }),
      });

      // Step 2: Atomic Push to Papers Database
      const pushRes = await fetch(`/api/admin/affiliate-submissions/${activeSubmission.id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const pushData = await pushRes.json();
      if (!pushRes.ok) {
        throw new Error(pushData.error || 'Failed to push paper to database.');
      }

      setModalSuccessMsg(
        `SUCCESS! Document approved and pushed to Papers database (Paper ID: ${pushData.paper.id}). Database count incremented by 1.`
      );

      // Update active submission
      const updatedSub: AffiliateSubmissionAdminRecord = {
        ...activeSubmission,
        status: 'approved',
        imported_paper_id: pushData.paper.id,
        imported_at: pushData.submission.imported_at,
        paper_title: editTitle,
        unit_code: editUnitCode,
      };
      setActiveSubmission(updatedSub);

      // Update submissions list
      setSubmissions((prev) =>
        prev.map((s) => (s.id === activeSubmission.id ? updatedSub : s))
      );

      // Notify parent to refresh papers list and counters
      if (onPaperPushed) {
        onPaperPushed();
      }
    } catch (err: any) {
      setModalErrorMsg(err.message || 'Error pushing paper to database.');
    } finally {
      setIsPushingPaper(false);
    }
  };

  const filtered = submissions.filter((sub) => {
    const term = searchTerm.toLowerCase().trim();
    const matchesSearch =
      !term ||
      sub.paper_title.toLowerCase().includes(term) ||
      sub.unit_code.toLowerCase().includes(term) ||
      sub.reference_code.toLowerCase().includes(term) ||
      sub.affiliate_name.toLowerCase().includes(term) ||
      sub.affiliate_email.toLowerCase().includes(term);

    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'pending' && sub.status === 'pending') ||
      (statusFilter === 'under_review' && sub.status === 'under_review') ||
      (statusFilter === 'approved' && sub.status === 'approved') ||
      (statusFilter === 'rejected' && sub.status === 'rejected');

    return matchesSearch && matchesStatus;
  });

  const isContentAdminOrSuper = adminRole === 'super_admin' || adminRole === 'content_admin';

  return (
    <div className="space-y-4">
      {/* Top Banner */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-extrabold text-white flex items-center gap-2">
            <UploadCloud className="w-4 h-4 text-[#00D26A]" />
            <span>Affiliate Paper Submissions &amp; Editorial Approval Gate</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Incoming past examination papers submitted by affiliates. Review, verify authenticity, and push to live Papers database.
          </p>
        </div>

        {/* Filter Badges & Refresh */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs shrink-0">
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                statusFilter === 'all' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({submissions.length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('pending')}
              className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                statusFilter === 'pending'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Pending ({submissions.filter((s) => s.status === 'pending').length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('approved')}
              className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                statusFilter === 'approved'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Imported ({submissions.filter((s) => s.status === 'approved').length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('rejected')}
              className={`px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                statusFilter === 'rejected'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Rejected ({submissions.filter((s) => s.status === 'rejected').length})
            </button>
          </div>

          <button
            type="button"
            onClick={fetchSubmissions}
            disabled={isLoading}
            className="p-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 hover:text-white transition-colors"
            title="Refresh submissions"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[#00D26A]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Search Input */}
      <div className="relative max-w-md">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by title, unit code, affiliate name, or SUB-ref..."
          className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-[#00D26A]"
        />
      </div>

      {/* Submissions Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-slate-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-[#00D26A] mx-auto mb-2" />
            Loading affiliate paper submissions...
          </div>
        ) : error ? (
          <div className="p-6 text-center text-rose-400 text-xs">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <UploadCloud className="w-10 h-10 text-slate-600 mx-auto" />
            <div className="text-sm font-bold text-slate-300">No Affiliate Submissions Found</div>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              {searchTerm || statusFilter !== 'all'
                ? 'No submissions match your query.'
                : 'Papers uploaded by affiliates will appear here for review and database approval.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold text-[11px]">
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Submission Ref</th>
                  <th className="py-3 px-4">Paper Title &amp; Unit Code</th>
                  <th className="py-3 px-4">Affiliate Contributor</th>
                  <th className="py-3 px-4">File Details</th>
                  <th className="py-3 px-4">Submitted Date</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.map((sub) => {
                  const fileSizeMb = (sub.file_size_bytes / (1024 * 1024)).toFixed(2);
                  const cleanPhone = sub.affiliate_phone.replace(/[^0-9]/g, '');
                  const intlPhone = cleanPhone.startsWith('0') ? `254${cleanPhone.slice(1)}` : cleanPhone;
                  const waMsg = encodeURIComponent(
                    `Hello ${sub.affiliate_name}, regarding your submitted paper "${sub.paper_title}" (${sub.reference_code}) on Godrery Publishers...`
                  );

                  return (
                    <tr key={sub.id} className="hover:bg-slate-800/40 transition-colors">
                      {/* Status */}
                      <td className="py-3 px-4 align-top whitespace-nowrap">
                        {sub.status === 'approved' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Imported</span>
                          </span>
                        ) : sub.status === 'rejected' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                            <XCircle className="w-3 h-3" />
                            <span>Rejected</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            <Clock className="w-3 h-3" />
                            <span>Pending Review</span>
                          </span>
                        )}
                      </td>

                      {/* Reference Code */}
                      <td className="py-3 px-4 align-top font-mono text-[11px] font-bold text-sky-400">
                        {sub.reference_code}
                      </td>

                      {/* Paper Title & Unit */}
                      <td className="py-3 px-4 align-top max-w-xs">
                        <div className="font-bold text-white text-xs">{sub.paper_title}</div>
                        <div className="text-[11px] text-emerald-400 font-mono font-semibold">
                          {sub.unit_code}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                          {sub.category} • {sub.academic_level}
                        </div>
                      </td>

                      {/* Affiliate Contributor */}
                      <td className="py-3 px-4 align-top">
                        <div className="font-semibold text-slate-200">{sub.affiliate_name}</div>
                        <div className="text-[11px] text-slate-400 font-mono">{sub.affiliate_email}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{sub.affiliate_phone}</div>
                      </td>

                      {/* File Details */}
                      <td className="py-3 px-4 align-top whitespace-nowrap text-slate-400 text-[11px]">
                        <div className="text-slate-300 font-medium truncate max-w-[140px]" title={sub.original_filename}>
                          {sub.original_filename}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {fileSizeMb} MB • {sub.total_pages || 4} Pages
                        </div>
                      </td>

                      {/* Date */}
                      <td className="py-3 px-4 align-top text-slate-400 text-[11px] whitespace-nowrap">
                        {new Date(sub.created_at).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 align-top text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openReviewModal(sub)}
                            className="px-3 py-1 rounded-lg bg-[#00D26A] hover:bg-[#00b85c] text-slate-950 text-xs font-bold transition-all shadow-sm flex items-center gap-1"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Review &amp; Push</span>
                          </button>

                          <a
                            href={`https://wa.me/${intlPhone}?text=${waMsg}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-[#00D26A] border border-[#00D26A]/30 transition-colors"
                            title="Message Contributor on WhatsApp"
                          >
                            <MessageCircle className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* REVIEW & PUSH MODAL */}
      {activeSubmission && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-3xl w-full p-6 sm:p-8 space-y-6 shadow-2xl my-8">
            {/* Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-black bg-sky-500/10 text-sky-400 border border-sky-500/30 px-2 py-0.5 rounded">
                    {activeSubmission.reference_code}
                  </span>
                  {activeSubmission.status === 'approved' ? (
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold px-2 py-0.5 rounded">
                      Imported into Papers Database
                    </span>
                  ) : activeSubmission.status === 'rejected' ? (
                    <span className="bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-bold px-2 py-0.5 rounded">
                      Rejected
                    </span>
                  ) : (
                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold px-2 py-0.5 rounded">
                      Pending Admin Review
                    </span>
                  )}
                </div>
                <h3 className="text-lg font-bold text-white mt-1.5">
                  Editorial Review &amp; Push to Papers Database
                </h3>
              </div>
              <button
                type="button"
                onClick={closeReviewModal}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Notifications */}
            {modalSuccessMsg && (
              <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#00D26A] shrink-0" />
                <span>{modalSuccessMsg}</span>
              </div>
            )}
            {modalErrorMsg && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{modalErrorMsg}</span>
              </div>
            )}

            {/* Document Viewer Preview & File Information */}
            <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold text-white text-xs">
                    {activeSubmission.original_filename}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {(activeSubmission.file_size_bytes / (1024 * 1024)).toFixed(2)} MB &nbsp;•&nbsp;{' '}
                    {activeSubmission.total_pages || 4} pages &nbsp;•&nbsp; {activeSubmission.mime_type}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <a
                  href={`/api/admin/affiliate-submissions/${activeSubmission.id}/file`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-[#00D26A]" />
                  <span>Open / Inspect Document</span>
                </a>
              </div>
            </div>

            {/* Contributor Information Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs">
              <div>
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Contributor:</span>
                <span className="text-white font-semibold">{activeSubmission.affiliate_name}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Email:</span>
                <span className="text-slate-300 font-mono">{activeSubmission.affiliate_email}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Phone / WhatsApp:</span>
                <span className="text-slate-300 font-mono">{activeSubmission.affiliate_phone}</span>
              </div>
            </div>

            {/* Editable Fields Section */}
            <div className="space-y-4">
              <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <span>Edit Metadata (Before Pushing to Database)</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-400">
                    Unit / Course Code
                  </label>
                  <input
                    type="text"
                    disabled={activeSubmission.status === 'approved'}
                    value={editUnitCode}
                    onChange={(e) => setEditUnitCode(e.target.value.toUpperCase())}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs font-mono uppercase focus:outline-none focus:border-[#00D26A] disabled:opacity-50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-400">
                    Paper Title
                  </label>
                  <input
                    type="text"
                    disabled={activeSubmission.status === 'approved'}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs focus:outline-none focus:border-[#00D26A] disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-400">
                    Category / Field
                  </label>
                  <input
                    type="text"
                    disabled={activeSubmission.status === 'approved'}
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs focus:outline-none focus:border-[#00D26A] disabled:opacity-50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-400">
                    Academic Level
                  </label>
                  <input
                    type="text"
                    disabled={activeSubmission.status === 'approved'}
                    value={editAcademicLevel}
                    onChange={(e) => setEditAcademicLevel(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs focus:outline-none focus:border-[#00D26A] disabled:opacity-50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-400">
                    Price (KES)
                  </label>
                  <input
                    type="number"
                    disabled={activeSubmission.status === 'approved'}
                    value={editPrice}
                    onChange={(e) => setEditPrice(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs font-mono focus:outline-none focus:border-[#00D26A] disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-bold text-slate-400">
                  Description / Notes
                </label>
                <textarea
                  rows={2}
                  disabled={activeSubmission.status === 'approved'}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white text-xs focus:outline-none focus:border-[#00D26A] disabled:opacity-50 resize-none"
                />
              </div>
            </div>

            {/* Rejection input box */}
            {showRejectInput && activeSubmission.status !== 'approved' && (
              <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 space-y-3">
                <label className="block text-xs font-bold text-rose-300">
                  Reason for Rejection (Recorded on Submission)
                </label>
                <input
                  type="text"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g. Duplicate paper, corrupted file, or blurry scan..."
                  className="w-full px-3 py-2 bg-slate-950 border border-rose-500/40 rounded-xl text-white text-xs focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSavingEdits}
                    onClick={handleRejectSubmission}
                    className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-all disabled:opacity-50"
                  >
                    Confirm Rejection
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRejectInput(false)}
                    className="px-3 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Modal Footer Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-slate-800">
              <div className="flex items-center gap-2 w-full sm:w-auto">
                {activeSubmission.status !== 'approved' && isContentAdminOrSuper && (
                  <>
                    <button
                      type="button"
                      disabled={isSavingEdits || isPushingPaper}
                      onClick={handleSaveEdits}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      <Save className="w-4 h-4 text-slate-400" />
                      <span>{isSavingEdits ? 'Saving...' : 'Save Edits'}</span>
                    </button>

                    {!showRejectInput && (
                      <button
                        type="button"
                        onClick={() => setShowRejectInput(true)}
                        className="px-3 py-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-xs font-bold transition-colors"
                      >
                        Reject
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* CRITICAL: PUSH TO PAPERS DATABASE BUTTON */}
              <div className="w-full sm:w-auto">
                {activeSubmission.status === 'approved' ? (
                  <div className="px-5 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-2 cursor-not-allowed">
                    <CheckCircle2 className="w-4 h-4 text-[#00D26A]" />
                    <span>Already Imported (ID: {activeSubmission.imported_paper_id})</span>
                  </div>
                ) : isContentAdminOrSuper ? (
                  <button
                    type="button"
                    disabled={isPushingPaper || isSavingEdits}
                    onClick={handlePushToPapers}
                    className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-[#00D26A] hover:bg-[#00b85c] disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-[#00D26A]/20 transition-all active:scale-[0.99] cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isPushingPaper ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin text-slate-950" />
                        <span>Pushing to Papers Database...</span>
                      </>
                    ) : (
                      <>
                        <Database className="w-4 h-4 text-slate-950" />
                        <span>Push to Papers Database</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="text-xs text-slate-500 italic">
                    Requires Content Admin or Super Admin role to push papers.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
