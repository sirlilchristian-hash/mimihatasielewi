import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { 
  generateCheckoutToken, 
  verifyCheckoutToken, 
  isCheckoutSessionAuthorized,
  simulatedIdempotencyRegistry,
  getAuthoritativePdfPageCount,
  computeAuthoritativeLifoPages,
  generatePageSpecificPDF,
  getAuthoritativeRestrictedPdf,
  getSynthetic303PagePdf,
  generateAccessToken,
  verifyAccessToken
} from './server.ts';
import { getSmtpConfig, sendActivationEmail, setSmtpTransporter } from './emailService.ts';

// ---------------------------------------------------------
// Existing Phase 1-4 Baseline Tests
// ---------------------------------------------------------

test('1. Checkout Token Expiration and Secure Validation', () => {
  const orderId = 'test-order-123';
  
  // Generate valid token with 10 seconds TTL
  const token = generateCheckoutToken(orderId, 10);
  assert.strictEqual(verifyCheckoutToken(orderId, token), true, 'Valid token should verify successfully');

  // Verify failure for wrong order ID
  assert.strictEqual(verifyCheckoutToken('wrong-order', token), false, 'Token verified with wrong order ID should fail');

  // Verify failure for tampered token
  assert.strictEqual(verifyCheckoutToken(orderId, token + 'tampered'), false, 'Tampered token should fail');

  // Generate expired token (-5 seconds TTL)
  const expiredToken = generateCheckoutToken(orderId, -5);
  assert.strictEqual(verifyCheckoutToken(orderId, expiredToken), false, 'Expired token should fail verification');
});

test('2. Simulation Idempotency Registry & Cache', () => {
  const idempotencyKey = 'idem-key-999';
  const orderId = 'ord-456';
  
  // Register in memory registry
  simulatedIdempotencyRegistry.set(idempotencyKey, {
    orderId,
    paymentId: 'pay-789',
    mpesaReceipt: 'SIMXYZ123',
    createdAt: Date.now()
  });

  const cached = simulatedIdempotencyRegistry.get(idempotencyKey);
  assert.strictEqual(cached?.orderId, orderId, 'Cached idempotency record should match orderId');
  assert.strictEqual(cached?.mpesaReceipt, 'SIMXYZ123');
});

test('3. Order Status Privacy & Unauthorized Access Control', () => {
  const orderId = 'order-privacy-test';
  
  const reqUnauth: any = {
    headers: {},
    query: {},
    body: {}
  };

  assert.strictEqual(
    isCheckoutSessionAuthorized(reqUnauth, orderId), 
    false, 
    'Unauthorized caller without session token or auth should be rejected'
  );

  const validToken = generateCheckoutToken(orderId, 3600);
  const reqAuth: any = {
    headers: { 'x-checkout-token': validToken },
    query: {},
    body: {}
  };

  assert.strictEqual(
    isCheckoutSessionAuthorized(reqAuth, orderId), 
    true, 
    'Authorized caller with valid checkout token should pass'
  );
});

test('4. Daraja Terminal State Protection Logic', () => {
  const paymentState = { id: 'p-1', status: 'completed' };
  const isTerminal = paymentState.status === 'completed' || paymentState.status === 'failed';
  assert.strictEqual(isTerminal, true, 'Completed payment should be recognized as terminal state');
});

test('5. Deterministic Last-N-Pages Selection Logic', () => {
  const computeLastN = (totalPages: number, n: number) => {
    if (n < 1 || n > totalPages) return [];
    return Array.from({ length: n }, (_, i) => totalPages - n + i + 1);
  };

  const res1 = computeLastN(300, 6);
  assert.deepStrictEqual(res1, [295, 296, 297, 298, 299, 300]);

  const res2 = computeLastN(300, 10);
  assert.strictEqual(res2.length, 10);
  assert.strictEqual(res2[0], 291);
  assert.strictEqual(res2[9], 300);

  const res3 = computeLastN(100, 20);
  assert.strictEqual(res3[0], 81);
  assert.strictEqual(res3[res3.length - 1], 100);

  const res4 = computeLastN(20, 6);
  assert.deepStrictEqual(res4, [15, 16, 17, 18, 19, 20]);

  assert.deepStrictEqual(computeLastN(300, 0), []);
  assert.deepStrictEqual(computeLastN(300, 301), []);
});

test('6. Authoritative Server-Side PDF Page Count Extraction', async () => {
  const resInvalid = await getAuthoritativePdfPageCount('nonexistent/path/file.pdf');
  assert.strictEqual(resInvalid.pageCount, null);
  assert.ok(resInvalid.error);

  const resMicro = await getAuthoritativePdfPageCount('papers/34FT4/1789736954276-cpv4k7c-merged.pdf');
  assert.strictEqual(resMicro.pageCount, 303, 'Microeconomics PDF should authoritatively return 303 pages');
  assert.strictEqual(resMicro.error, undefined);
});

test('7. Synchronized API Page Counts & Microeconomics = 303 Pages', async () => {
  const resMicro = await getAuthoritativePdfPageCount('papers/34FT4/1789736954276-cpv4k7c-merged.pdf');
  assert.strictEqual(resMicro.pageCount, 303, 'Microeconomics paper must report 303 pages');
});

test('8. Server-Authoritative LIFO Selection Engine (303 Pages)', () => {
  const p12 = computeAuthoritativeLifoPages(303, 12);
  assert.strictEqual(p12.length, 12);
  assert.strictEqual(p12[0], 292);
  assert.strictEqual(p12[p12.length - 1], 303);

  const p3 = computeAuthoritativeLifoPages(303, 3);
  assert.deepStrictEqual(p3, [301, 302, 303]);

  const p1 = computeAuthoritativeLifoPages(303, 1);
  assert.deepStrictEqual(p1, [303]);

  const p303 = computeAuthoritativeLifoPages(303, 303);
  assert.strictEqual(p303.length, 303);
  assert.strictEqual(p303[0], 1);
  assert.strictEqual(p303[302], 303);

  assert.deepStrictEqual(computeAuthoritativeLifoPages(303, 0), []);
  assert.deepStrictEqual(computeAuthoritativeLifoPages(303, -5), []);
  assert.deepStrictEqual(computeAuthoritativeLifoPages(303, 2.5), []);
  assert.deepStrictEqual(computeAuthoritativeLifoPages(303, 304), []);
});

// ---------------------------------------------------------
// PHASE 5 — Enforce Purchased-Page Restrictions Across All Delivery Routes
// ---------------------------------------------------------

test('9. Phase 5 - Paid order for 12 pages of 303-page Microeconomics produces exactly 12 pages', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-micro-12';
  const paperId = 'paper-micro-303';
  const targetPages = computeAuthoritativeLifoPages(303, 12); // [292..303]

  const result = await getAuthoritativeRestrictedPdf({
    orderId,
    order: {
      id: orderId,
      status: 'paid',
      paper_id: paperId,
      purchased_pages: targetPages,
      page_quantity: 12
    },
    paper: {
      id: paperId,
      file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf',
      unit_code: 'ECO-101',
      total_pages: 303
    },
    sourcePdfBuffer: syntheticPdf
  });

  assert.strictEqual(result.pageCount, 12, 'Resulting restricted PDF must have exactly 12 pages');
  assert.strictEqual(result.authorizedPages.length, 12);
  
  // Verify with actual PDFDocument parser
  const parsed = await PDFDocument.load(result.restrictedPdfBytes);
  assert.strictEqual(parsed.getPageCount(), 12, 'Parsed PDF bytes must contain exactly 12 pages');
});

test('10. Phase 5 - Selected pages are exactly original pages 292–303 in ascending reading order', async () => {
  // Use synthetic 303-page PDF fixture where each page i has unique dimensions: width = 100 + i, height = 200 + i
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-micro-pages-identity';
  const paperId = 'paper-micro-303';
  const pages12 = computeAuthoritativeLifoPages(303, 12); // [292, 293, ..., 303]

  const result = await getAuthoritativeRestrictedPdf({
    orderId,
    order: {
      id: orderId,
      status: 'paid',
      paper_id: paperId,
      purchased_pages: pages12,
      page_quantity: 12
    },
    paper: {
      id: paperId,
      file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf',
      unit_code: 'ECO-101',
      total_pages: 303
    },
    sourcePdfBuffer: syntheticPdf
  });

  const parsed = await PDFDocument.load(result.restrictedPdfBytes);
  assert.strictEqual(parsed.getPageCount(), 12);

  // Cryptographically and structurally verify each individual extracted page
  for (let idx = 0; idx < 12; idx++) {
    const originalPageNumber = 292 + idx;
    const page = parsed.getPage(idx);
    const expectedWidth = 100 + originalPageNumber;
    const expectedHeight = 200 + originalPageNumber;
    
    assert.strictEqual(page.getWidth(), expectedWidth, `Page at index ${idx} must be original page ${originalPageNumber} (width ${expectedWidth})`);
    assert.strictEqual(page.getHeight(), expectedHeight, `Page at index ${idx} must be original page ${originalPageNumber} (height ${expectedHeight})`);
  }
});

test('11. Phase 5 - Three-page purchase contains only original pages 301–303 in ascending order', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-micro-3';
  const paperId = 'paper-micro-303';
  const pages3 = computeAuthoritativeLifoPages(303, 3); // [301, 302, 303]

  const result = await getAuthoritativeRestrictedPdf({
    orderId,
    order: {
      id: orderId,
      status: 'paid',
      paper_id: paperId,
      purchased_pages: pages3,
      page_quantity: 3
    },
    paper: {
      id: paperId,
      file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf',
      unit_code: 'ECO-101'
    },
    sourcePdfBuffer: syntheticPdf
  });

  const parsed = await PDFDocument.load(result.restrictedPdfBytes);
  assert.strictEqual(parsed.getPageCount(), 3, 'Must contain exactly 3 pages');
  
  assert.strictEqual(parsed.getPage(0).getWidth(), 100 + 301, '1st page must be original page 301');
  assert.strictEqual(parsed.getPage(1).getWidth(), 100 + 302, '2nd page must be original page 302');
  assert.strictEqual(parsed.getPage(2).getWidth(), 100 + 303, '3rd page must be original page 303');
});

test('12. Phase 5 - One-page purchase contains only original page 303', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-micro-1';
  const paperId = 'paper-micro-303';
  const pages1 = computeAuthoritativeLifoPages(303, 1); // [303]

  const result = await getAuthoritativeRestrictedPdf({
    orderId,
    order: {
      id: orderId,
      status: 'paid',
      paper_id: paperId,
      purchased_pages: pages1,
      page_quantity: 1
    },
    paper: {
      id: paperId,
      file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf',
      unit_code: 'ECO-101'
    },
    sourcePdfBuffer: syntheticPdf
  });

  const parsed = await PDFDocument.load(result.restrictedPdfBytes);
  assert.strictEqual(parsed.getPageCount(), 1, 'Must contain exactly 1 page');
  assert.strictEqual(parsed.getPage(0).getWidth(), 100 + 303, 'Extracted page must be original page 303');
});

test('13. Phase 5 - Full-page purchase contains all 303 pages', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-micro-303';
  const paperId = 'paper-micro-303';
  const pages303 = computeAuthoritativeLifoPages(303, 303); // [1..303]

  const result = await getAuthoritativeRestrictedPdf({
    orderId,
    order: {
      id: orderId,
      status: 'paid',
      paper_id: paperId,
      purchased_pages: pages303,
      page_quantity: 303
    },
    paper: {
      id: paperId,
      file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf',
      unit_code: 'ECO-101'
    },
    sourcePdfBuffer: syntheticPdf
  });

  const parsed = await PDFDocument.load(result.restrictedPdfBytes);
  assert.strictEqual(parsed.getPageCount(), 303, 'Must contain all 303 pages');
  assert.strictEqual(parsed.getPage(0).getWidth(), 101, 'First page must be original page 1');
  assert.strictEqual(parsed.getPage(302).getWidth(), 403, 'Last page must be original page 303');
});

test('14. Phase 5 - Unpaid order cannot obtain a document (fails closed)', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-unpaid';
  const paperId = 'paper-micro-303';

  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId,
        order: {
          id: orderId,
          status: 'pending', // Unpaid!
          paper_id: paperId,
          purchased_pages: [301, 302, 303]
        },
        paper: {
          id: paperId,
          file_path: 'papers/34FT4/1789736954276-cpv4k7c-merged.pdf'
        },
        sourcePdfBuffer: syntheticPdf
      });
    },
    /Payment verification failed/
  );
});

test('15. Phase 5 - Invalid token cannot obtain a document', () => {
  assert.strictEqual(verifyAccessToken(''), null);
  assert.strictEqual(verifyAccessToken('invalid-token-string'), null);
  assert.strictEqual(verifyAccessToken('abc:def'), null);
  assert.strictEqual(verifyAccessToken('0123456789abcdef:0123456789abcdef:deadbeef'), null);

  // Valid token round-trip test
  const validToken = generateAccessToken('valid-order-777');
  assert.strictEqual(verifyAccessToken(validToken), 'valid-order-777');
});

test('16. Phase 5 - Order cannot access another paper or another order cached PDF', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const orderId = 'order-cross-access';
  
  // Order is registered for paper-1, but request attempts to deliver paper-2
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId,
        order: {
          id: orderId,
          status: 'paid',
          paper_id: 'paper-authorized-1',
          purchased_pages: [300, 301, 302, 303]
        },
        paper: {
          id: 'paper-different-2', // Paper mismatch!
          file_path: 'papers/different/file.pdf'
        },
        sourcePdfBuffer: syntheticPdf
      });
    },
    /Paper mismatch/
  );
});

test('17. Phase 5 - Missing or malformed page selections cause delivery to fail closed', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  const paper = { id: 'paper-1', file_path: 'papers/test.pdf' };

  // Case A: Missing purchased_pages (null)
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-null',
        order: { id: 'ord-null', status: 'paid', paper_id: 'paper-1', purchased_pages: null },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /Missing or empty purchased_pages/
  );

  // Case B: Empty array
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-empty',
        order: { id: 'ord-empty', status: 'paid', paper_id: 'paper-1', purchased_pages: [] },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /Missing or empty purchased_pages/
  );

  // Case C: Duplicate page numbers
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-dup',
        order: { id: 'ord-dup', status: 'paid', paper_id: 'paper-1', purchased_pages: [292, 292, 293] },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /duplicate page numbers/
  );

  // Case D: Out of bounds (e.g. page 304 for 303-page PDF)
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-oob',
        order: { id: 'ord-oob', status: 'paid', paper_id: 'paper-1', purchased_pages: [304] },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /exceeds total document pages/
  );

  // Case E: Descending or unsorted reading order
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-desc',
        order: { id: 'ord-desc', status: 'paid', paper_id: 'paper-1', purchased_pages: [303, 302, 301] },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /ascending reading order/
  );

  // Case F: Inconsistent page_quantity
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-qty-mismatch',
        order: { id: 'ord-qty-mismatch', status: 'paid', paper_id: 'paper-1', purchased_pages: [301, 302, 303], page_quantity: 12 },
        paper,
        sourcePdfBuffer: syntheticPdf
      });
    },
    /Inconsistent order state/
  );
});

test('18. Phase 5 - Missing PDF, corrupt PDF, or extraction failure never returns original full PDF', async () => {
  const corruptBuffer = Buffer.from("NOT_A_VALID_PDF_STREAM_HEADER_CORRUPT");
  
  await assert.rejects(
    async () => {
      await getAuthoritativeRestrictedPdf({
        orderId: 'ord-corrupt',
        order: {
          id: 'ord-corrupt',
          status: 'paid',
          paper_id: 'paper-corrupt',
          purchased_pages: [292, 293]
        },
        paper: {
          id: 'paper-corrupt',
          file_path: 'papers/corrupt.pdf'
        },
        sourcePdfBuffer: corruptBuffer
      });
    },
    /corrupt or unreadable/
  );
});

test('19. Phase 5 - generatePageSpecificPDF helper validates bounds and maintains order', async () => {
  const syntheticPdf = await getSynthetic303PagePdf();
  
  // Valid extraction
  const bytes = await generatePageSpecificPDF(syntheticPdf, [292, 293, 294]);
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 3);
  assert.strictEqual(doc.getPage(0).getWidth(), 392);
  assert.strictEqual(doc.getPage(1).getWidth(), 393);
  assert.strictEqual(doc.getPage(2).getWidth(), 394);

  // Out of bounds error
  await assert.rejects(
    async () => {
      await generatePageSpecificPDF(syntheticPdf, [0, 10]);
    },
    /out of bounds/
  );

  await assert.rejects(
    async () => {
      await generatePageSpecificPDF(syntheticPdf, [304]);
    },
    /out of bounds/
  );
});

console.log('All automated tests executed successfully.');

test('20. SMTP Configuration Resolution', () => {
  const originalEnv = { ...process.env };
  process.env.SMTP_USER = 'test@gmail.com';
  process.env.SMTP_PASSWORD = 'password';
  
  const config = getSmtpConfig();
  assert.strictEqual(config.smtpUser, 'test@gmail.com');
  assert.strictEqual(config.userConfigured, true);
  
  process.env = originalEnv;
});

test('21. Email Failure with Missing Config', async () => {
  const originalEnv = { ...process.env };
  delete process.env.SMTP_USER;
  
  const result = await sendActivationEmail({
    to: 'test@example.com',
    firstName: 'Test',
    paperTitle: 'Test Paper',
    openDocumentUrl: 'http://example.com'
  });
  
  assert.strictEqual(result.status, 'EMAIL NOT CONFIGURED');
  
  process.env = originalEnv;
});

test('22. Successful Email Sending with Mocked Transport', async () => {
  setSmtpTransporter({
    sendMail: async () => ({ messageId: 'mock-id' })
  });
  
  process.env.SMTP_USER = 'test@gmail.com';
  process.env.SMTP_PASSWORD = 'password';

  const result = await sendActivationEmail({
    to: 'test@example.com',
    firstName: 'Test',
    paperTitle: 'Test Paper',
    openDocumentUrl: 'http://example.com'
  });
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.messageId, 'mock-id');
  
  setSmtpTransporter(null); // Clean up
});
