import type { PGlite } from '@electric-sql/pglite';

import { getDb } from './db/connection.js';

// --- Scenario definitions ---

export interface DemoScenario {
  id: number;
  label: string;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  { id: 1, label: 'Main UI — all tickets with detail panel' },
  { id: 2, label: 'Quick entry — bullet-list ticket creation' },
  { id: 3, label: 'Sidebar filtering — custom views and categories' },
  { id: 4, label: 'AI worklist — Up Next tickets with notes' },
  { id: 5, label: 'Batch operations — multi-select toolbar' },
  { id: 6, label: 'Detail panel — bottom orientation with tags and notes' },
  { id: 7, label: 'Column view — kanban board by status' },
  { id: 8, label: 'Dashboard — stats and charts' },
  { id: 9, label: 'Claude Channel — AI integration with custom commands' },
  { id: 10, label: 'Multi-project tabs — multiple projects in one window' },
  { id: 11, label: 'Embedded terminal — drawer with named terminal tabs and PTY output' },
  { id: 12, label: 'Terminal dashboard — every terminal across every project at once' },
  { id: 13, label: 'Telemetry — cross-project Claude Code cost tracking (HS-8682)' },
  { id: 14, label: 'Announcer — A/V narration of project work (transcript PIP)' },
];

// --- Ticket data model ---

interface DemoTicket {
  title: string;
  details: string;
  category: string;
  priority: string;
  status: string;
  up_next: boolean;
  notes: string; // JSON-encoded array or empty
  tags: string[]; // tag strings
  days_ago: number;
  updated_ago: number;
  completed_ago?: number;
  verified_ago?: number;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setTime(d.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

let noteId = 0;
function notesJson(entries: { text: string; days_ago: number }[]): string {
  if (entries.length === 0) return '';
  return JSON.stringify(entries.map(e => ({
    id: `n_demo_${noteId++}`,
    text: e.text,
    created_at: daysAgo(e.days_ago),
  })));
}

// --- Scenario 1: Hero — main UI with all tickets ---
// Shows: variety of categories, priorities, statuses, tags, up_next, detail panel content

const SCENARIO_1: DemoTicket[] = [
  {
    title: 'Fix checkout failing when cart has mixed shipping methods',
    details: 'When a cart contains items with different shipping methods (standard + express), the checkout process fails at the shipping calculation step.\n\nSteps to reproduce:\n1. Add an item with standard shipping\n2. Add an item with express-only shipping\n3. Proceed to checkout\n4. Error at shipping step: "Unable to calculate shipping"\n\nLikely issue is in ShippingCalculator.consolidate() which assumes a single method.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    tags: ['checkout', 'shipping'],
    notes: notesJson([{ text: 'Confirmed the issue is in ShippingCalculator.consolidate(). It uses a single rate lookup instead of per-item calculation. Working on a fix that groups items by shipping method and merges the rates.', days_ago: 0.5 }]),
    days_ago: 5, updated_ago: 0.5,
  },
  {
    title: 'Add product comparison view for category pages',
    details: 'Users should be able to select 2-4 products and see a side-by-side comparison table showing specs, price, ratings, and availability.',
    category: 'feature', priority: 'high', status: 'not_started', up_next: true,
    tags: ['ux', 'product-pages'],
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Set up automated database backups to S3',
    details: 'Configure daily pg_dump backups with 30-day retention. Use the existing AWS credentials from the infra stack. Should run at 03:00 UTC.',
    category: 'task', priority: 'high', status: 'started', up_next: true,
    tags: ['infrastructure', 'devops'],
    notes: notesJson([{ text: 'Created the backup script and IAM role. Testing the S3 lifecycle policy for retention.', days_ago: 1 }]),
    days_ago: 7, updated_ago: 1,
  },
  {
    title: 'Evaluate Stripe vs Square for payment processing',
    details: 'Compare fees, API quality, international support, and dispute handling. We need a recommendation by end of sprint.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: true,
    tags: ['payments'],
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Product images not loading on slow connections',
    details: 'Users on 3G connections report broken product images. Likely need progressive loading and proper srcset/sizes attributes.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['performance', 'images'],
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Allow customers to save multiple shipping addresses',
    details: 'Currently limited to one address. Users should be able to store and label multiple addresses (Home, Work, etc.) and pick during checkout.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['checkout', 'accounts'],
    notes: '', days_ago: 10, updated_ago: 10,
  },
  {
    title: 'Update tax calculation to handle EU VAT rules',
    details: 'Need to support reverse charge for B2B and country-specific VAT rates. The current flat-rate approach is incorrect for EU customers.',
    category: 'requirement_change', priority: 'default', status: 'started', up_next: false,
    tags: ['tax', 'eu', 'compliance'],
    notes: '', days_ago: 8, updated_ago: 2,
  },
  {
    title: 'Write API documentation for order endpoints',
    details: 'Document all /api/orders/* endpoints with request/response examples using OpenAPI 3.0 format.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    tags: ['docs', 'api'],
    notes: notesJson([{ text: 'Documented all 12 order endpoints with examples. Published to /docs.', days_ago: 1 }]),
    days_ago: 12, updated_ago: 1, completed_ago: 1,
  },
  {
    title: 'Fix CORS headers blocking mobile app API requests',
    details: 'The mobile app gets CORS errors on preflight OPTIONS requests. Need to add proper Access-Control headers for the mobile origin.',
    category: 'bug', priority: 'highest', status: 'verified', up_next: false,
    tags: ['mobile', 'api'],
    notes: notesJson([
      { text: 'Added CORS middleware with correct origins. Tested against staging with the mobile app builds.', days_ago: 3 },
      { text: 'Verified fix is working in production. No more CORS errors in mobile app error logs.', days_ago: 2 },
    ]),
    days_ago: 14, updated_ago: 2, completed_ago: 3, verified_ago: 2,
  },
  {
    title: 'Add dark mode support',
    details: 'Implement system-preference detection and manual toggle. Use CSS custom properties for theming.',
    category: 'feature', priority: 'low', status: 'not_started', up_next: false,
    tags: ['ux', 'theming'],
    notes: '', days_ago: 15, updated_ago: 15,
  },
  {
    title: 'Migrate to connection pooling for database',
    details: 'Switch from individual connections to pgBouncer or built-in pooling. Current approach is causing connection exhaustion under load.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    tags: ['infrastructure', 'database'],
    notes: notesJson([{ text: 'Migrated to pg pool with max 20 connections. Load tested successfully at 500 concurrent requests.', days_ago: 4 }]),
    days_ago: 18, updated_ago: 4, completed_ago: 4,
  },
  {
    title: 'Research SSR frameworks for product pages',
    details: 'Evaluate Next.js, Remix, and Astro for SEO-critical product pages. Need to consider hydration cost and build complexity.',
    category: 'investigation', priority: 'lowest', status: 'not_started', up_next: false,
    tags: ['frontend', 'seo'],
    notes: '', days_ago: 20, updated_ago: 20,
  },
];

// --- Scenario 2: Quick entry --- few tickets, focus on draft row ---

const SCENARIO_2: DemoTicket[] = [
  {
    title: 'Fix login redirect loop after session timeout',
    details: 'After session timeout, the redirect goes to /login?next=/login which creates an infinite loop.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    tags: ['auth'], notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Add CSV export for order reports',
    details: 'Admin users need to export filtered order data as CSV for accounting.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['admin'], notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Update dependencies to latest versions',
    details: 'Several packages have security patches available. Run npm audit and update.',
    category: 'task', priority: 'default', status: 'started', up_next: false,
    tags: ['maintenance'], notes: '', days_ago: 1, updated_ago: 0.5,
  },
];

// --- Scenario 3: Sidebar filtering with custom views ---

const SCENARIO_3: DemoTicket[] = [
  {
    title: 'Fix checkout totals rounding incorrectly on multi-item carts',
    details: 'Subtotals accumulate floating-point errors. Use integer cents for all calculations.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    tags: ['checkout', 'pricing'], notes: '', days_ago: 3, updated_ago: 1,
  },
  {
    title: 'Search returns stale results after product update',
    details: 'The search index isn\'t being refreshed when product details change.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    tags: ['search'], notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Email notifications sent with wrong timezone offset',
    details: 'All notification timestamps show UTC instead of the user\'s configured timezone.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['notifications'], notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Implement real-time inventory tracking',
    details: 'Use WebSocket connections to push stock level changes to the product page.',
    category: 'feature', priority: 'high', status: 'started', up_next: true,
    tags: ['real-time', 'inventory'],
    notes: notesJson([{ text: 'WebSocket server is set up. Working on the client-side stock badge component.', days_ago: 0.5 }]),
    days_ago: 6, updated_ago: 0.5,
  },
  {
    title: 'Add wishlist sharing via email',
    details: 'Users can generate a shareable link or send their wishlist directly to an email address.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['social'], notes: '', days_ago: 9, updated_ago: 9,
  },
  {
    title: 'Product video support on detail pages',
    details: 'Allow merchants to upload product videos alongside photos.',
    category: 'feature', priority: 'low', status: 'not_started', up_next: false,
    tags: ['media'], notes: '', days_ago: 12, updated_ago: 12,
  },
  {
    title: 'Migrate image storage to CDN',
    details: 'Move product images from local disk to CloudFront.',
    category: 'task', priority: 'high', status: 'started', up_next: false,
    tags: ['infrastructure', 'images'], notes: '', days_ago: 4, updated_ago: 2,
  },
  {
    title: 'Support guest checkout without account creation',
    details: 'Many users abandon at the registration step. Allow checkout with just email.',
    category: 'requirement_change', priority: 'high', status: 'not_started', up_next: true,
    tags: ['checkout', 'conversion'], notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Compare Redis vs Memcached for session storage',
    details: 'Evaluate Redis and Memcached for persistence, speed, and ops complexity.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: false,
    tags: ['infrastructure'], notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Analyze mobile conversion drop-off funnel',
    details: 'Mobile users convert at 1.2% vs 3.8% desktop. Investigate where users drop off.',
    category: 'investigation', priority: 'default', status: 'not_started', up_next: false,
    tags: ['analytics', 'mobile'], notes: '', days_ago: 11, updated_ago: 11,
  },
];

// --- Scenario 4: AI worklist — Up Next tickets with progress notes ---

const SCENARIO_4: DemoTicket[] = [
  {
    title: 'Fix race condition in concurrent order placement',
    details: 'When two orders are placed simultaneously for the last item in stock, both succeed and inventory goes negative.\n\nNeed to add row-level locking in OrderService.place() or use a serializable transaction.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    tags: ['concurrency', 'orders'],
    notes: notesJson([
      { text: 'Reproduced the issue with a concurrent request test. The problem is in OrderService.place() — it reads inventory, then decrements in a separate query without locking.', days_ago: 1 },
      { text: 'Implemented SELECT ... FOR UPDATE on the inventory row. Running stress tests to confirm the fix holds under load.', days_ago: 0.3 },
    ]),
    days_ago: 4, updated_ago: 0.3,
  },
  {
    title: 'Add webhook notifications for order status changes',
    details: 'Merchants need to receive POST webhooks when order status changes (placed, shipped, delivered, cancelled). Include order details and a signature header for verification.',
    category: 'feature', priority: 'high', status: 'not_started', up_next: true,
    tags: ['webhooks', 'api'],
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Add input validation to all public API endpoints',
    details: 'Several endpoints accept unvalidated input. Add zod schemas for request bodies and query params on all /api/* routes.',
    category: 'task', priority: 'high', status: 'not_started', up_next: true,
    tags: ['security', 'api'],
    notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Fix decimal precision loss in price calculations',
    details: 'Prices stored as NUMERIC(10,2) but JavaScript floating-point math causes rounding errors in totals. Convert all price math to integer cents.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: true,
    tags: ['pricing'],
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Evaluate caching strategies for product catalog',
    details: 'Product pages are slow under load. Investigate Redis caching, CDN edge caching, and stale-while-revalidate patterns.',
    category: 'investigation', priority: 'default', status: 'not_started', up_next: true,
    tags: ['performance', 'caching'],
    notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Add bulk product import from CSV',
    details: 'Merchants need to upload a CSV of products to create/update inventory in batch.',
    category: 'feature', priority: 'low', status: 'completed', up_next: false,
    tags: ['admin', 'import'],
    notes: notesJson([
      { text: 'Implemented CSV parser using papaparse. Supports create and update modes with duplicate detection by SKU.', days_ago: 3 },
      { text: 'Added validation for required fields (name, price, SKU) and friendly error messages with row numbers.', days_ago: 2 },
    ]),
    days_ago: 10, updated_ago: 2, completed_ago: 2,
  },
  {
    title: 'Normalize database schema for customer addresses',
    details: 'Addresses are currently embedded as JSON in the customers table. Extract to a separate addresses table.',
    category: 'task', priority: 'default', status: 'verified', up_next: false,
    tags: ['database', 'schema'],
    notes: notesJson([
      { text: 'Created migration to extract addresses into a new table. Backfilled 12,400 existing address records.', days_ago: 5 },
      { text: 'Verified the migration ran correctly. All address lookups use the new table.', days_ago: 3 },
    ]),
    days_ago: 14, updated_ago: 3, completed_ago: 5, verified_ago: 3,
  },
];

// --- Scenario 5: Batch operations — many similar tickets to batch-select ---

const SCENARIO_5: DemoTicket[] = [
  {
    title: 'Fix email template rendering in Outlook',
    details: 'Order confirmation emails break in Outlook due to unsupported CSS flexbox.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['email'], notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Handle timeout on third-party shipping rate API',
    details: 'When the shipping provider API times out, show a retry prompt instead of a 500 error.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['shipping', 'error-handling'], notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Fix pagination on search results page',
    details: 'Page 2+ of search results shows duplicate items.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['search'], notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Cart badge count not updating after item removal',
    details: 'The header cart icon shows the old count until a full page refresh.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: false,
    tags: ['cart', 'ui'], notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Add order tracking page for customers',
    details: 'Customers need a page showing shipment status, tracking number, and estimated delivery.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['orders', 'ux'], notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Implement product review moderation queue',
    details: 'Admin interface to approve/reject/flag user reviews before they appear publicly.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['admin', 'reviews'], notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Add rate limiting to public API endpoints',
    details: 'Protect against abuse with per-IP rate limiting. Target: 100 req/min anonymous, 500 authenticated.',
    category: 'task', priority: 'default', status: 'not_started', up_next: false,
    tags: ['security', 'api'], notes: '', days_ago: 8, updated_ago: 8,
  },
  {
    title: 'Set up staging environment on AWS',
    details: 'Mirror production setup with smaller instances. Auto-deploy from the develop branch.',
    category: 'task', priority: 'default', status: 'not_started', up_next: false,
    tags: ['infrastructure', 'devops'], notes: '', days_ago: 9, updated_ago: 9,
  },
  {
    title: 'Clean up unused CSS classes from redesign',
    details: 'The recent redesign left ~40 unused CSS classes. Run PurgeCSS and remove dead code.',
    category: 'task', priority: 'low', status: 'not_started', up_next: false,
    tags: ['cleanup'], notes: '', days_ago: 12, updated_ago: 12,
  },
  {
    title: 'Archive completed migration files older than 6 months',
    details: 'Move old migration files to an archive directory to keep the migrations folder manageable.',
    category: 'task', priority: 'low', status: 'not_started', up_next: false,
    tags: ['cleanup', 'database'], notes: '', days_ago: 14, updated_ago: 14,
  },
];

// --- Scenario 6: Detail panel bottom with tags and rich notes ---

const SCENARIO_6: DemoTicket[] = [
  {
    title: 'Implement real-time order tracking with WebSockets',
    details: 'Build a live order tracking view that pushes status updates to the customer in real-time.\n\nRequirements:\n- WebSocket connection per active order\n- Status events: confirmed, preparing, shipped, out_for_delivery, delivered\n- Reconnect logic with exponential backoff\n- Fallback to polling for browsers without WebSocket support\n\nThe tracking page should show a visual timeline with the current step highlighted.',
    category: 'feature', priority: 'highest', status: 'started', up_next: true,
    tags: ['real-time', 'orders', 'websocket'],
    notes: notesJson([
      { text: 'Set up the WebSocket server using ws library. Basic connection lifecycle working — connect, heartbeat, disconnect with cleanup.', days_ago: 3 },
      { text: 'Implemented the event broadcast system. When an order status changes in the API, all connected clients for that order receive a push event. Added Redis pub/sub for multi-server support.', days_ago: 2 },
      { text: 'Built the client-side tracking timeline component. Shows all 5 status steps with the current one highlighted. Working on the reconnect logic next.', days_ago: 0.5 },
    ]),
    days_ago: 6, updated_ago: 0.5,
  },
  {
    title: 'Fix memory leak in product search indexer',
    details: 'The search indexer process grows from 200MB to 2GB+ over 24 hours. Likely a reference leak in the batch processing pipeline.',
    category: 'bug', priority: 'high', status: 'started', up_next: true,
    tags: ['performance', 'memory', 'search'],
    notes: notesJson([{ text: 'Heap snapshot shows the BatchProcessor holding references to completed batches. The onComplete callbacks are never cleaned up.', days_ago: 1 }]),
    days_ago: 5, updated_ago: 1,
  },
  {
    title: 'Add comprehensive test coverage for payment flow',
    details: 'The payment processing flow has no integration tests. Add tests covering: successful payment, declined card, network timeout, partial refund, and currency conversion.',
    category: 'task', priority: 'high', status: 'not_started', up_next: true,
    tags: ['testing', 'payments'],
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Add product recommendations based on purchase history',
    details: 'Show "Customers also bought" recommendations on product pages using collaborative filtering.',
    category: 'feature', priority: 'default', status: 'completed', up_next: false,
    tags: ['ml', 'recommendations', 'product-pages'],
    notes: notesJson([
      { text: 'Implemented a simple collaborative filtering algorithm. Computes item-item similarity from co-purchase frequency in the last 90 days.', days_ago: 5 },
      { text: 'Added the recommendations API endpoint and the product page widget. Limited to 4 recommendations. Recalculation runs nightly via cron.', days_ago: 3 },
    ]),
    days_ago: 12, updated_ago: 3, completed_ago: 3,
  },
  {
    title: 'Migrate static assets to CDN',
    details: 'Product images, CSS, and JS bundles should be served from CloudFront.',
    category: 'task', priority: 'default', status: 'verified', up_next: false,
    tags: ['infrastructure', 'cdn', 'performance'],
    notes: notesJson([
      { text: 'Configured CloudFront distribution with S3 origin. Migrated all product images (42GB).', days_ago: 7 },
      { text: 'Updated asset URLs. Cache hit rate is at 94% after 48 hours. TTFB improved from 240ms to 35ms.', days_ago: 5 },
    ]),
    days_ago: 16, updated_ago: 5, completed_ago: 7, verified_ago: 5,
  },
  {
    title: 'Fix broken breadcrumb links on category pages',
    details: 'Nested category breadcrumbs link to the wrong parent when the category tree is more than 3 levels deep.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    tags: ['navigation', 'ui'],
    notes: '', days_ago: 8, updated_ago: 8,
  },
];

// --- Scenario 7: Column view — kanban board ---

const SCENARIO_7: DemoTicket[] = [
  {
    title: 'Implement product search autocomplete',
    details: 'Add typeahead suggestions to the search bar using the product name index.',
    category: 'feature', priority: 'highest', status: 'not_started', up_next: true,
    tags: ['search', 'ux'], notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Fix broken password reset flow for SSO users',
    details: 'SSO users who try to reset their password get a generic error.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    tags: ['auth', 'sso'], notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Add support for gift cards at checkout',
    details: 'Support gift card codes during checkout with partial redemption and balance tracking.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    tags: ['checkout', 'payments'], notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Investigate slow query on order history page',
    details: 'The order history page takes 4+ seconds for users with 200+ orders.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: false,
    tags: ['performance', 'database'], notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Refactor authentication middleware to support API keys',
    details: 'Third-party integrations need API key auth in addition to session cookies.',
    category: 'task', priority: 'high', status: 'started', up_next: true,
    tags: ['auth', 'api'],
    notes: notesJson([{ text: 'Created the AuthStrategy interface and migrated session auth. Working on the API key strategy next.', days_ago: 0.5 }]),
    days_ago: 4, updated_ago: 0.5,
  },
  {
    title: 'Fix cart not clearing after successful checkout',
    details: 'The clearCart() call is inside a catch block by mistake.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    tags: ['checkout', 'cart'],
    notes: notesJson([{ text: 'Found the issue — clearCart() was moved into the catch block during a refactor. Fixing and adding a test.', days_ago: 0.3 }]),
    days_ago: 1, updated_ago: 0.3,
  },
  {
    title: 'Update shipping rate calculation for oversized items',
    details: 'Dimensional weight pricing is required for packages over 1 cubic foot.',
    category: 'requirement_change', priority: 'default', status: 'started', up_next: false,
    tags: ['shipping', 'pricing'],
    notes: notesJson([{ text: 'Implemented dim weight formula. Comparing rates against the carrier API.', days_ago: 1 }]),
    days_ago: 6, updated_ago: 1,
  },
  {
    title: 'Add end-to-end tests for the checkout flow',
    details: 'Write Playwright tests covering: add to cart, apply coupon, enter shipping, pay, and confirm.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    tags: ['testing', 'e2e'],
    notes: notesJson([{ text: 'Wrote 8 E2E tests covering the full checkout flow including coupon application and payment decline handling.', days_ago: 1 }]),
    days_ago: 8, updated_ago: 1, completed_ago: 1,
  },
  {
    title: 'Fix product image carousel swipe on mobile',
    details: 'Swipe gestures conflict with the browser back gesture.',
    category: 'bug', priority: 'default', status: 'completed', up_next: false,
    tags: ['mobile', 'ui'],
    notes: notesJson([{ text: 'Added a 30px horizontal threshold. Tested on iOS Safari and Chrome Android.', days_ago: 2 }]),
    days_ago: 7, updated_ago: 2, completed_ago: 2,
  },
  {
    title: 'Set up log aggregation with structured JSON logging',
    details: 'Replace console.log calls with pino. Send logs to a central aggregation service.',
    category: 'task', priority: 'low', status: 'completed', up_next: false,
    tags: ['observability', 'logging'],
    notes: notesJson([{ text: 'Replaced all console.log with pino. Configured log shipping. Alert rules set for error-level logs.', days_ago: 3 }]),
    days_ago: 10, updated_ago: 3, completed_ago: 3,
  },
];

// --- Scenario 8: Dashboard — needs historical data spread across time ---

const SCENARIO_8: DemoTicket[] = [];
// Dashboard scenario uses ticket data from scenarios 1+4 combined to show good chart data
// The actual chart data comes from stats_snapshots which we'll backfill

// Build scenario 8 from a mix that gives good throughput/flow data
for (let i = 0; i < 30; i++) {
  const cats = ['bug', 'feature', 'task', 'investigation', 'requirement_change', 'issue'];
  const pris = ['highest', 'high', 'default', 'low', 'lowest'];
  const statuses = ['not_started', 'started', 'completed', 'verified'];
  const status = statuses[i < 8 ? 0 : i < 14 ? 1 : i < 24 ? 2 : 3];
  const completed = status === 'completed' || status === 'verified' ? 30 - i + Math.floor(Math.random() * 5) : undefined;
  const verified = status === 'verified' ? (completed! - 2) : undefined;
  SCENARIO_8.push({
    title: `Dashboard ticket ${i + 1} — ${cats[i % cats.length]} work item`,
    details: '',
    category: cats[i % cats.length],
    priority: pris[i % pris.length],
    status,
    up_next: i < 3,
    tags: [],
    notes: status === 'completed' || status === 'verified' ? notesJson([{ text: 'Completed work.', days_ago: completed! }]) : '',
    days_ago: 30 - i + Math.floor(Math.random() * 10),
    updated_ago: completed ?? Math.floor(Math.random() * 10),
    completed_ago: completed,
    verified_ago: verified,
  });
}

// --- Scenario 9: Claude Channel integration — play button, custom commands, AI-driven workflow ---

const SCENARIO_9: DemoTicket[] = [
  {
    title: 'Fix race condition in WebSocket message ordering',
    details: 'Messages arriving during reconnect can be delivered out of order. Need to add sequence numbers and a reorder buffer on the client side.\n\nReproduction: disconnect WiFi briefly during a burst of real-time updates, then reconnect — events appear in wrong order.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    tags: ['websocket', 'real-time'],
    notes: notesJson([
      { text: 'Investigating — the issue is in the reconnect handler. When the socket reconnects, buffered server-side messages are flushed immediately without checking the client sequence counter.', days_ago: 0.1 },
    ]),
    days_ago: 3, updated_ago: 0.1,
  },
  {
    title: 'Add rate limiting to public API endpoints',
    details: 'Implement token bucket rate limiting for all /api/v2/ endpoints. 100 requests per minute per API key, with burst allowance of 20.',
    category: 'feature', priority: 'high', status: 'not_started', up_next: true,
    tags: ['api', 'security'],
    notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Migrate user preferences to new schema',
    details: 'The preferences table needs to be migrated from the old key-value format to the new typed JSON column. Write a migration script that preserves existing user settings.',
    category: 'task', priority: 'default', status: 'not_started', up_next: true,
    tags: ['database', 'migration'],
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Investigate slow query on orders dashboard',
    details: 'The orders dashboard takes 8+ seconds to load for merchants with >10k orders. Need to profile the SQL and add appropriate indexes.',
    category: 'investigation', priority: 'high', status: 'completed', up_next: false,
    tags: ['performance', 'database'],
    notes: notesJson([
      { text: 'Root cause: missing composite index on (merchant_id, created_at). The query was doing a full table scan. Added index and query time dropped from 8.2s to 45ms.', days_ago: 1 },
    ]),
    days_ago: 5, updated_ago: 1, completed_ago: 1,
  },
  {
    title: 'Update error handling middleware to use structured logging',
    details: 'Replace console.error calls with structured JSON logging using pino. Include request ID, user context, and stack traces.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    tags: ['observability', 'logging'],
    notes: notesJson([
      { text: 'Replaced all console.error/warn calls with pino logger. Added request ID propagation via AsyncLocalStorage. Error responses now include a correlationId for support debugging.', days_ago: 2 },
    ]),
    days_ago: 7, updated_ago: 2, completed_ago: 2,
  },
  {
    title: 'Fix CORS headers missing on preflight for webhook endpoints',
    details: 'Third-party integrations sending OPTIONS preflight requests to /webhooks/* get 405 Method Not Allowed.',
    category: 'bug', priority: 'default', status: 'verified', up_next: false,
    tags: ['api', 'webhooks'],
    notes: notesJson([
      { text: 'Added CORS preflight handler for webhook routes. Configured allowed origins from the integration settings table.', days_ago: 4 },
    ]),
    days_ago: 9, updated_ago: 4, completed_ago: 5, verified_ago: 4,
  },
  {
    title: 'Design new onboarding flow for team workspaces',
    details: 'The current onboarding drops users into an empty workspace. Design a guided setup that creates sample data and walks through key features.',
    category: 'feature', priority: 'low', status: 'not_started', up_next: false,
    tags: ['onboarding', 'ux'],
    notes: '', days_ago: 10, updated_ago: 10,
  },
];

// --- Scenario data lookup ---

const SCENARIO_DATA: Record<number, DemoTicket[]> = {
  1: SCENARIO_1,
  2: SCENARIO_2,
  3: SCENARIO_3,
  4: SCENARIO_4,
  5: SCENARIO_5,
  6: SCENARIO_6,
  7: SCENARIO_7,
  8: SCENARIO_8,
  9: SCENARIO_9,
  10: SCENARIO_1, // Primary project uses hero data; extra projects added by seedDemoExtraProjects
  11: SCENARIO_1, // Reuses hero tickets so the screenshot shows tickets + terminal drawer together
  12: SCENARIO_1, // Primary project for the dashboard demo; extra projects + terminal config added by seedDemoExtraProjects
  13: SCENARIO_1, // Primary project for the cross-project telemetry demo (HS-8682); extra projects + otel_metrics seeded by seedDemoExtraProjects
  14: SCENARIO_1, // Announcer demo — hero tickets fill the board behind the transcript PIP; the announcer endpoints themselves are mocked client-side by capture-demos.ts (the PIP needs an Anthropic key / on-device provider that can't be seeded headlessly)
};

// --- Custom views for scenario 3 ---

const SCENARIO_3_VIEWS = [
  {
    id: 'high-priority-bugs',
    name: 'High Priority Bugs',
    logic: 'all',
    conditions: [
      { field: 'category', operator: 'equals', value: 'bug' },
      { field: 'priority', operator: 'lte', value: 'high' },
    ],
  },
  {
    id: 'active-features',
    name: 'Active Features',
    logic: 'all',
    conditions: [
      { field: 'category', operator: 'equals', value: 'feature' },
      { field: 'status', operator: 'lte', value: 'started' },
    ],
  },
];

// --- Custom commands for scenario 9 ---

const SCENARIO_9_COMMANDS = [
  { name: 'Commit Changes', prompt: 'Make a commit for the recently completed tickets.', icon: 'git-commit-horizontal', color: '#6b7280' },
  { type: 'group', name: 'Testing', children: [
    { name: 'Run Tests', prompt: 'Run the test suite and report any failures.', icon: 'test-tubes', color: '#3b82f6' },
    { name: 'Code Review', prompt: 'Review the recent changes for code quality and potential issues.', icon: 'search-code', color: '#8b5cf6' },
  ]},
  { type: 'group', name: 'Deploy', children: [
    { name: 'Deploy Staging', prompt: 'Deploy the current branch to the staging environment.', icon: 'rocket', color: '#f97316' },
    { name: 'Deploy Production', prompt: 'Deploy to production after staging verification.', icon: 'rocket', color: '#ef4444', target: 'shell' },
  ]},
];

// --- Configured terminals for scenario 11 (embedded terminal showcase) ---
//
// Each entry shows a different visible-output shape so the screenshot
// communicates what the integrated terminal looks like in practice. The
// `printf` calls produce the visible content; `exec sleep 3600` keeps the
// PTY alive without spawning an interactive shell prompt that would
// clutter the screenshot. The user (or whoever captures the screenshot)
// can recapture with real commands if they want a more realistic look.

// HS-8419 sweep 6 / commit bac041c: the printf-then-`exec sleep 3600`
// pattern only renders correctly when `lazy: true`. Eager-spawned sessions
// hit attach.ts:93's HS-6799 redraw-on-first-attach path which clears
// scrollback and writes Ctrl-L to the PTY — sleep doesn't consume stdin,
// so the line discipline echoes the Ctrl-L back as `^L` and the printf
// output is wiped. Lazy terminals spawn on first WS attach, so the printf
// streams directly into the live subscriber after the no-op resize branch.
//
// HS-8688 scenario-12 trade-off: the §25 dashboard's tile virtualization only
// mounts tiles whose state is already `'alive'` (`mountIfNotMounted = tile.
// state === 'alive'` in `terminalTileGridLifecycle.tsx`). Lazy tiles therefore
// stay cold ("Not yet started" play-glyph placeholders) until the user clicks
// them — fine in the drawer demo where ONE terminal is the focus, but
// catastrophic in the dashboard demo where every cold placeholder is its own
// visual blemish. Scenario 12 needs `lazy: false` so the eager-spawn path
// (`eagerSpawnTerminals` at registerProject time) lights up every tile in
// the grid. The printf decoration is dropped for scenario 12 — the HS-6799
// scrollback clear wipes it on first attach anyway, leaving an "empty
// alive" tile (running but blank xterm). That's the lesser visual hit: a
// grid of running terminals beats a grid of cold placeholders even if each
// tile lacks the printf flavor text.
const DEMO_TERMINAL_APPEARANCE = { theme: 'github-dark', fontSize: 15 } as const;

const SCENARIO_11_TERMINALS = [
  {
    id: 'dev-server',
    name: 'Dev Server',
    command: "printf '\\033[36m> npm run dev\\033[0m\\n\\n  ➜  Local:   http://localhost:3000/\\n  ➜  Network: http://192.168.1.42:3000/\\n\\n  ready in 412ms\\n\\n\\033[2m  watching for changes...\\033[0m\\n'; exec sleep 3600",
    lazy: true,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'tests',
    name: 'Tests',
    command: "printf '\\033[36m> npm run test:watch\\033[0m\\n\\n\\033[32m  ✓\\033[0m auth/session.test.ts (12)\\n\\033[32m  ✓\\033[0m api/tickets.test.ts (47)\\n\\033[32m  ✓\\033[0m db/queries.test.ts (89)\\n\\033[32m  ✓\\033[0m client/dom.test.ts (23)\\n\\n\\033[32m Test Files \\033[0m\\033[1m4 passed\\033[0m\\033[90m (4)\\033[0m\\n\\033[32m      Tests \\033[0m\\033[1m171 passed\\033[0m\\033[90m (171)\\033[0m\\n\\n\\033[2m  watching for changes...\\033[0m\\n'; exec sleep 3600",
    lazy: true,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'claude',
    name: 'Claude',
    command: '{{claudeCommand}}',
    lazy: true,
    ...DEMO_TERMINAL_APPEARANCE,
  },
];

// HS-8688 / HS-8689 — scenario-12-only terminal configs. Eager (`lazy: false`)
// so `eagerSpawnTerminals` lights them up at project registration and the §25
// dashboard sees `tile.state === 'alive'` when it first renders the grid.
//
// HS-8689 — each terminal renders a styled, content-rich simulation matching
// its title (Dev Server → Vite-style server output, Tests → test runner pass
// summary, Claude → Claude Code session) so the dashboard grid telegraphs
// "real developer workflows" instead of an uninformative wall of black tiles.
// The bare `exec sleep 3600` from the HS-8688 first pass produced alive-but-
// blank xterms which the user flagged as visually flat.
//
// Pattern: `stty -echoctl 2>/dev/null; while :; do {clear+printf content};
// sleep 10; done`. The continuous re-emit beats the HS-6799 first-attach
// scrollback clear in `attach.ts:97` — within 10 s of attach the next loop
// iteration repaints the content. `stty -echoctl` (best-effort; some PTYs
// reject it but we never see the failure) suppresses the `^L` byte the line
// discipline echoes when HS-6799 writes Ctrl-L to a PTY where nothing reads
// stdin. `\033[H\033[2J` is "cursor home + clear-screen" — equivalent to the
// `clear` command but no PATH dependency. The shell-side `while :;` keeps
// reusing the same TTY without a re-exec.
const SCENARIO_12_PRIMARY_TERMINALS = [
  {
    id: 'dev-server',
    name: 'Dev Server',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[36m> npm run dev\\033[0m\\n\\n  VITE v5.4.0  ready in \\033[1m412\\033[0m ms\\n\\n  \\033[32m➜\\033[0m  Local:   \\033[36mhttp://localhost:3000/\\033[0m\\n  \\033[32m➜\\033[0m  Network: \\033[36mhttp://192.168.1.42:3000/\\033[0m\\n\\n  \\033[2m[HMR] update: src/client/styles.scss\\033[0m\\n  \\033[2m[HMR] update: src/client/detail.tsx\\033[0m\\n\\n\\033[2m  watching for file system changes...\\033[0m\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'tests',
    name: 'Tests',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[36m> npm run test:watch\\033[0m\\n\\n \\033[32m RUN \\033[0m v4.1.7\\n\\n \\033[32m✓\\033[0m  src/client/dom.test.ts \\033[2m(12)\\033[0m \\033[2m48 ms\\033[0m\\n \\033[32m✓\\033[0m  src/client/state.test.tsx \\033[2m(8)\\033[0m \\033[2m31 ms\\033[0m\\n \\033[32m✓\\033[0m  src/db/queries.test.ts \\033[2m(47)\\033[0m \\033[2m214 ms\\033[0m\\n \\033[32m✓\\033[0m  src/routes/tickets.test.ts \\033[2m(31)\\033[0m \\033[2m158 ms\\033[0m\\n\\n \\033[32m Test Files \\033[0m \\033[1m4 passed\\033[0m\\033[2m (4)\\033[0m\\n \\033[32m      Tests \\033[0m \\033[1m98 passed\\033[0m\\033[2m (98)\\033[0m\\n \\033[32m   Duration \\033[0m 451 ms\\n\\n\\033[2m  watching for changes...\\033[0m\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'claude',
    name: 'Claude',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[36mClaude Code\\033[0m \\033[2mv2.0.0  (opus-4-7)\\033[0m\\n\\n\\033[33m>\\033[0m implement dark mode toggle in the settings dialog\\n\\n\\033[32m●\\033[0m Reading project layout\\n  \\033[2m└─ src/client/settingsDialog.tsx\\033[0m\\n  \\033[2m└─ src/client/styles.scss\\033[0m\\n\\n\\033[32m●\\033[0m Adding theme toggle to General tab\\n  \\033[2m└─ Edit(src/client/settingsDialog.tsx) +18 -2\\033[0m\\n  \\033[2m└─ Edit(src/client/styles.scss) +24 -0\\033[0m\\n\\n\\033[32m●\\033[0m Running tests \\033[32m✓ 12 passed\\033[0m\\n\\nDark mode toggle is live in General → Theme.\\n\\n\\033[33m>\\033[0m \\033[7m \\033[0m\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
];

// --- Telemetry seeding (scenario 13, HS-8682) ---

/**
 * HS-8682 — seed `otel_metrics` cost.usage rows for the §70 cross-project
 * stats demo. Inserts deterministic-but-varied cost rows into the shared
 * telemetry DB (per §67.6 the otel tables live in the default project's DB
 * keyed by `project_secret`). Targets ~30 days of trailing data per project
 * spread across 2-3 models and working-hour timestamps so the cost-over-time
 * chart + cost-by-project table + model donut + hourly heatmap all render
 * with meaningful data. Determinism is keyed off the project secret so the
 * same demo launch produces the same screenshot.
 *
 * `projectIndex` is a 0-based ordering hint that drives a per-project
 * intensity multiplier — index 0 is the busiest project in the rollup, so
 * the cost-by-project table has a clear winner instead of three near-equal
 * rows.
 */
async function seedDemoTelemetryRows(
  db: PGlite,
  projectSecret: string,
  projectIndex: number,
): Promise<void> {
  const models = ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'] as const;
  const querySources = ['main_agent', 'subagent'] as const;
  const projectMultiplier = projectIndex === 0 ? 1.4 : projectIndex === 1 ? 1.0 : 0.6;

  // Deterministic 32-bit hash seeded by the project secret. Same secret →
  // same data → reproducible screenshots across launches.
  const seedFromString = (s: string): number => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) + s.charCodeAt(i)) >>> 0;
    return h >>> 0;
  };
  const projectSeed = seedFromString(projectSecret);
  const rand = (i: number): number => {
    // Mulberry32-ish: deterministic PRNG fed by (projectSeed, i).
    let x = (projectSeed + i * 2_654_435_761) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995) >>> 0; x ^= x >>> 15;
    return (x >>> 0) / 0x100000000;
  };

  const now = Date.now();
  let counter = 0;

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const dayMs = now - dayOffset * 86_400_000;
    // Weekend dip — the heatmap looks more believable with a weekday peak.
    const dow = new Date(dayMs).getDay();
    const weekdayBoost = (dow >= 1 && dow <= 5) ? 1.5 : 0.5;
    const promptsToday = Math.floor((rand(dayOffset) * 6 + 2) * weekdayBoost * projectMultiplier);

    for (let p = 0; p < promptsToday; p++) {
      counter++;
      const modelIdx = Math.floor(rand(counter * 7) * models.length);
      const model = models[Math.min(modelIdx, models.length - 1)];
      // Opus dominates the cost; sonnet middle; haiku cheap.
      const modelMultiplier = model.includes('opus') ? 2.5 : model.includes('sonnet') ? 1.0 : 0.3;
      const baseCost = 0.02 + rand(counter * 11) * 1.48; // $0.02-$1.50 base
      const cost = +(baseCost * modelMultiplier).toFixed(4);

      // Spread within working hours (8-22) so the heatmap has a visible
      // workday band rather than smearing through 3am.
      const hour = Math.floor(rand(counter * 13) * 14) + 8;
      const minute = Math.floor(rand(counter * 17) * 60);
      const second = Math.floor(rand(counter * 19) * 60);
      const ts = new Date(dayMs);
      ts.setHours(hour, minute, second, 0);

      const sourceIdx = rand(counter * 23) < 0.85 ? 0 : 1; // main_agent dominant
      const querySource = querySources[sourceIdx];
      const sessionId = `sess-demo-${projectIndex}-${dayOffset}-${p}`;

      // HS-8900 — the window-total chips show cost + tokens + prompts. Cost comes
      // from `claude_code.cost.usage`; tokens from `claude_code.token.usage`
      // (`type` = input/output); the prompt count falls back to distinct
      // `attributes_json->>'session.id'` on cost rows when no log events carry a
      // prompt_id (the demo seeds no otel_events). Seeding only the cost row left
      // the chips reading "0 tokens · 0 prompts" next to a real dollar figure. So
      // stamp `session.id` on the cost row AND emit a paired input/output
      // token.usage row, with plausible counts derived from the same PRNG.
      const inputTokens = Math.round(1500 + rand(counter * 29) * 18_500); // ~1.5k–20k
      const outputTokens = Math.round(300 + rand(counter * 31) * 4_700); // ~0.3k–5k

      await db.query(
        `INSERT INTO otel_metrics
           (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
         VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
        [
          ts.toISOString(),
          projectSecret,
          sessionId,
          'claude_code.cost.usage',
          JSON.stringify({ model, 'query.source': querySource, 'session.id': sessionId }),
          JSON.stringify({ asDouble: cost }),
          'delta',
          true,
        ],
      );

      for (const [type, count] of [['input', inputTokens], ['output', outputTokens]] as const) {
        await db.query(
          `INSERT INTO otel_metrics
             (ts, project_secret, session_id, metric_name, attributes_json, value_json, aggregation_temporality, is_monotonic)
           VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
          [
            ts.toISOString(),
            projectSecret,
            sessionId,
            'claude_code.token.usage',
            JSON.stringify({ model, 'query.source': querySource, 'session.id': sessionId, type }),
            JSON.stringify({ asInt: count }),
            'delta',
            true,
          ],
        );
      }
    }
  }
}

// --- Seeding ---

export async function seedDemoData(scenario: number): Promise<void> {
  const db = await getDb();
  if (!(scenario in SCENARIO_DATA)) return;
  const tickets = SCENARIO_DATA[scenario];

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    const ticketNumber = `HS-${i + 1}`;
    const createdAt = daysAgo(t.days_ago);
    const updatedAt = daysAgo(t.updated_ago);
    const completedAt = t.completed_ago !== undefined ? daysAgo(t.completed_ago) : null;
    const verifiedAt = t.verified_ago !== undefined ? daysAgo(t.verified_ago) : null;
    const tags = JSON.stringify(t.tags);

    await db.query(`
      INSERT INTO tickets (ticket_number, title, details, category, priority, status, up_next, notes, tags, created_at, updated_at, completed_at, verified_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $11::timestamp, $12::timestamp, $13::timestamp)
    `, [ticketNumber, t.title, t.details, t.category, t.priority, t.status, t.up_next, t.notes, tags, createdAt, updatedAt, completedAt, verifiedAt]);
  }

  // Advance the sequence past seeded tickets so new ones don't collide
  await db.query(`SELECT setval('ticket_seq', $1)`, [tickets.length]);

  // Scenario-specific settings (written to settings.json)
  const { getDataDir } = await import('./db/connection.js');
  const { writeProjectSettings } = await import('./file-settings.js');
  const dataDir = getDataDir();

  // HS-8430 — column view is the more visually compelling + more
  // representative mode for marketing screenshots, so default the demo
  // scenarios to column layout. Two exceptions stay in list view:
  //   - Scenario 2 (Quick entry): the bullet-list entry row is the
  //     demo's content; list view IS the demo.
  //   - Scenario 6 (Detail panel bottom orientation): bottom-panel UX
  //     is the demo's focus, and list view + bottom panel is the
  //     natural pairing the screenshot wants to show.
  // Scenario 7 (the explicit "Column view — kanban board" demo) was
  // already column; that's preserved. Scenario 8 (Dashboard) overrides
  // the layout entirely with its own view so the setting doesn't
  // matter — left out for clarity.
  const COLUMN_VIEW_SCENARIOS = new Set([1, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14]);
  if (COLUMN_VIEW_SCENARIOS.has(scenario)) {
    writeProjectSettings(dataDir, { layout: 'columns' });
  }

  if (scenario === 3) {
    writeProjectSettings(dataDir, { custom_views: JSON.stringify(SCENARIO_3_VIEWS) });
  }
  if (scenario === 6) {
    writeProjectSettings(dataDir, { detail_position: 'bottom', detail_height: '280' });
  }
  if (scenario === 8) {
    // Backfill stats snapshots for dashboard charts
    const { backfillSnapshots, recordDailySnapshot } = await import('./db/stats.js');
    await backfillSnapshots();
    await recordDailySnapshot();
  }
  if (scenario === 9) {
    // Enable Claude Channel and add custom command buttons
    writeProjectSettings(dataDir, {
      channel_enabled: 'true',
      custom_commands: JSON.stringify(SCENARIO_9_COMMANDS),
    });
  }
  if (scenario === 11) {
    // HS-8430 follow-up — embedded terminal showcase. Open the drawer
    // on the first terminal tab and configure three terminals with
    // canned PTY output so the screenshot shows what the integrated
    // terminal actually looks like (rather than an empty prompt that
    // could be any shell). Each terminal uses `printf` for the visible
    // output then `exec sleep 3600` so the PTY stays alive without
    // surfacing a shell prompt that would clutter the screenshot.
    //
    // HS-8688 — `drawer_expanded` removed (was `'true'`). The expanded
    // drawer hogged ~70% of the viewport, leaving the ticket list as a
    // sliver — per the ticket: "you expanded the bottom drawer but i
    // think leaving it at the original height might be better".
    writeProjectSettings(dataDir, {
      drawer_open: 'true',
      drawer_active_tab: 'terminal:dev-server',
      terminals: JSON.stringify(SCENARIO_11_TERMINALS),
    });
  }
  if (scenario === 13) {
    // HS-8682 — cross-project telemetry stats showcase. Enable telemetry on
    // the primary project so the header-bar `#cross-project-stats-toggle`
    // button renders (visibility-gated on `anyProjectHasTelemetryEnabled()`
    // per §70). The otel_metrics rows themselves are seeded in
    // `seedDemoExtraProjects` after all 3 project secrets are known. The
    // descriptive `appName` keeps the cost-by-project table readable next
    // to the curated extras (otherwise the primary would render as a
    // temp-dir basename). Uses `writeFileSettings` directly because
    // `telemetry_enabled` is a typed boolean on the wire (per
    // `src/api/settings.ts`), and `writeProjectSettings` would coerce it
    // to the string `'true'` — which then fails the `!== true` server-side
    // gate in `src/terminals/registry/otelEnv.ts`.
    const { writeFileSettings: writeFs } = await import('./file-settings.js');
    writeFs(dataDir, { appName: 'Hot Sheet Web App', telemetry_enabled: true });
  }
  if (scenario === 12) {
    // Terminal dashboard showcase. The dashboard's "see everything at
    // once" appeal only lands when there are multiple projects each
    // with multiple terminals — a single-project dashboard would just
    // look like a project-scoped grid (which is what §36's drawer-grid
    // is for). So we configure the primary project with three terminals
    // and `seedDemoExtraProjects` registers two additional projects
    // (Mobile App + API Platform) each with their own 2-3 terminals.
    // The dashboard-open flag is in-memory only (§25), so the user
    // clicks the `square-terminal` toolbar button after launch to enter
    // the view — the screenshot workflow then captures all ~7 terminals
    // as a single grid.
    //
    // HS-8688 — uses `SCENARIO_12_PRIMARY_TERMINALS` (eager / no printf)
    // instead of `SCENARIO_11_TERMINALS` (lazy / printf). See the
    // SCENARIO_12_PRIMARY_TERMINALS comment for the rationale.
    writeProjectSettings(dataDir, {
      terminals: JSON.stringify(SCENARIO_12_PRIMARY_TERMINALS),
    });
  }
}

// --- Scenario 10: Multi-project tabs — extra projects ---

interface ExtraProject {
  appName: string;
  tickets: DemoTicket[];
}

/** Extra-project terminal configs for the §25 dashboard showcase
 *  (scenario 12). Each project gets a couple of visibly-distinct
 *  terminals so the dashboard grid has variety.
 *
 *  HS-8688 / HS-8689 — eager (`lazy: false`) so the dashboard sees them
 *  alive at first render (see `SCENARIO_12_PRIMARY_TERMINALS` comment for
 *  the dashboard-virtualization rationale), and each terminal uses the
 *  same `stty -echoctl; while :; do clear-then-printf; sleep 10; done`
 *  pattern as the primary terminals so the styled content survives the
 *  HS-6799 first-attach scrollback clear. Content matches each terminal's
 *  title — Metro renders a React Native start banner, logcat renders
 *  Android log lines, API Server renders a service-listening summary,
 *  pg log renders Postgres query logs. */
const SCENARIO_12_MOBILE_TERMINALS = [
  {
    id: 'metro',
    name: 'Metro',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[36m> npx react-native start\\033[0m\\n\\n  Welcome to \\033[1mMetro\\033[0m v0.81.0\\n  Fast \\033[2m-\\033[0m Scalable \\033[2m-\\033[0m Integrated\\n\\n  Dev server ready. Press \\033[1mi\\033[0m for iOS, \\033[1ma\\033[0m for Android.\\n\\n  \\033[32m✓\\033[0m Bundling \\033[2mindex.js\\033[0m   complete \\033[2m(2841 modules)\\033[0m\\n  \\033[32m✓\\033[0m Bundling \\033[2mauth/index\\033[0m  complete \\033[2m(412 modules)\\033[0m\\n\\n\\033[2m  watching files for changes...\\033[0m\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'logcat',
    name: 'logcat',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[2m11-18 09:42:01.213\\033[0m \\033[36mPush.deeplink\\033[0m  Received: orders/9821\\n\\033[2m11-18 09:42:01.241\\033[0m \\033[36mPush.deeplink\\033[0m  Resolving intent…\\n\\033[2m11-18 09:42:01.252\\033[0m \\033[36mPush.deeplink\\033[0m  Routing to OrderDetail\\n\\033[2m11-18 09:42:01.318\\033[0m \\033[35mRender\\033[0m         OrderDetailScreen mounted\\n\\033[2m11-18 09:42:01.402\\033[0m \\033[33mNetwork\\033[0m        GET /api/orders/9821 \\033[32m200\\033[0m \\033[2m218ms\\033[0m\\n\\033[2m11-18 09:42:01.541\\033[0m \\033[35mRender\\033[0m         OrderDetail items=4 total=$184.20\\n\\033[2m11-18 09:42:02.819\\033[0m \\033[36mUser\\033[0m           tap: Mark as delivered\\n\\033[2m11-18 09:42:02.864\\033[0m \\033[33mNetwork\\033[0m        PATCH /api/orders/9821 \\033[32m200\\033[0m \\033[2m41ms\\033[0m\\n\\033[2m11-18 09:42:02.871\\033[0m \\033[32mState\\033[0m          order.status=delivered\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
];
const SCENARIO_12_API_TERMINALS = [
  {
    id: 'server',
    name: 'API Server',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[36m> npm run dev:api\\033[0m\\n\\n  api.platform.local listening on \\033[1m:8080\\033[0m\\n  graphql:  \\033[36mhttp://localhost:8080/graphql\\033[0m\\n  rest:     \\033[36mhttp://localhost:8080/v1\\033[0m\\n  health:   \\033[32mok\\033[0m\\n\\n  \\033[2m09:42:14\\033[0m \\033[32mPOST\\033[0m /v1/auth/login        \\033[32m200\\033[0m \\033[2m18ms\\033[0m\\n  \\033[2m09:42:15\\033[0m \\033[32mGET \\033[0m /v1/orders?status=open \\033[32m200\\033[0m \\033[2m41ms\\033[0m\\n  \\033[2m09:42:15\\033[0m \\033[34mPOST\\033[0m /v1/orders/9821/ship  \\033[32m201\\033[0m \\033[2m72ms\\033[0m\\n\\n  \\033[33mWARN\\033[0m rate-limiter bucket at 87%% (auth tier=basic)\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
  {
    id: 'db-tail',
    name: 'pg log',
    command: "stty -echoctl 2>/dev/null; while :; do printf '\\033[H\\033[2J\\033[2m2026-05-18 09:41:03 UTC\\033[0m \\033[32mLOG:\\033[0m  duration: \\033[1m12.4 ms\\033[0m  statement: SELECT * FROM orders WHERE id = $1\\n\\033[2m2026-05-18 09:41:03 UTC\\033[0m \\033[32mLOG:\\033[0m  duration: \\033[1m4.1 ms\\033[0m   statement: UPDATE orders SET status=$1 WHERE id=$2\\n\\033[2m2026-05-18 09:41:03 UTC\\033[0m \\033[32mLOG:\\033[0m  checkpoint complete: wrote 41 buffers (0.3%%)\\n\\033[2m2026-05-18 09:41:04 UTC\\033[0m \\033[32mLOG:\\033[0m  duration: \\033[1m187.2 ms\\033[0m statement: REFRESH MATERIALIZED VIEW order_metrics\\n\\033[2m2026-05-18 09:41:04 UTC\\033[0m \\033[33mWARN:\\033[0m  pg_stat_statements has 247 entries\\n\\033[2m2026-05-18 09:41:05 UTC\\033[0m \\033[32mLOG:\\033[0m  duration: \\033[1m2.9 ms\\033[0m   statement: SELECT pg_advisory_lock($1)\\n\\033[2m2026-05-18 09:41:05 UTC\\033[0m \\033[32mLOG:\\033[0m  duration: \\033[1m1.4 ms\\033[0m   statement: COMMIT\\n'; sleep 10; done",
    lazy: false,
    ...DEMO_TERMINAL_APPEARANCE,
  },
];

const EXTRA_PROJECTS: ExtraProject[] = [
  {
    appName: 'Mobile App',
    tickets: [
      { title: 'Push notification deep links not opening correct screen', details: 'Tapping a push notification for an order update opens the home screen instead of the order detail. Affects both iOS and Android.', category: 'bug', priority: 'highest', status: 'started', up_next: true, tags: ['notifications'], notes: notesJson([{ text: 'Confirmed the intent URI is malformed on Android. iOS works for some notification types but not order updates.', days_ago: 0.5 }]), days_ago: 3, updated_ago: 0.5 },
      { title: 'Add biometric login (Face ID / fingerprint)', details: 'Allow users to authenticate with biometrics after initial login. Store a refresh token in the secure keychain.', category: 'feature', priority: 'high', status: 'not_started', up_next: true, tags: ['auth', 'security'], notes: '', days_ago: 5, updated_ago: 5 },
      { title: 'Offline mode for product catalog', details: 'Cache the product catalog locally so users can browse without network. Sync changes when connection is restored.', category: 'feature', priority: 'default', status: 'not_started', up_next: false, tags: ['offline', 'sync'], notes: '', days_ago: 7, updated_ago: 7 },
      { title: 'App crashes on low-memory devices during checkout', details: 'Reports from Android users with 2GB RAM that the app crashes when loading the payment form. Need to profile memory usage.', category: 'bug', priority: 'high', status: 'not_started', up_next: true, tags: ['android', 'performance'], notes: '', days_ago: 2, updated_ago: 2 },
      { title: 'Update to React Native 0.76', details: 'New architecture is now stable. Update from 0.73 and enable the new renderer. Run full regression test suite after.', category: 'task', priority: 'default', status: 'completed', up_next: false, tags: ['dependencies'], notes: notesJson([{ text: 'Updated and all tests passing. New renderer is 15% faster on list scrolling benchmarks.', days_ago: 1 }]), days_ago: 10, updated_ago: 1, completed_ago: 1 },
    ],
  },
  {
    appName: 'API Platform',
    tickets: [
      { title: 'Rate limiter returning 429 for authenticated internal calls', details: 'Internal service-to-service calls using API keys are being rate limited. They should bypass the public rate limit.', category: 'bug', priority: 'highest', status: 'started', up_next: true, tags: ['rate-limiting', 'internal'], notes: notesJson([{ text: 'The rate limiter key includes the IP but not the API key type. Internal keys need a separate bucket with higher limits.', days_ago: 0.2 }]), days_ago: 1, updated_ago: 0.2 },
      { title: 'Add GraphQL subscriptions for real-time updates', details: 'Implement WebSocket-based GraphQL subscriptions for order status changes and inventory updates.', category: 'feature', priority: 'high', status: 'not_started', up_next: true, tags: ['graphql', 'websocket'], notes: '', days_ago: 6, updated_ago: 6 },
      { title: 'Migrate to OpenAPI 3.1 spec', details: 'Current spec is OpenAPI 3.0. Upgrade to 3.1 for JSON Schema compatibility and webhook support.', category: 'task', priority: 'default', status: 'not_started', up_next: false, tags: ['api-docs'], notes: '', days_ago: 8, updated_ago: 8 },
      { title: 'Investigate P99 latency spike on /orders endpoint', details: 'P99 jumped from 200ms to 1.2s after last deploy. No obvious code changes. Check connection pool and query plans.', category: 'investigation', priority: 'high', status: 'completed', up_next: false, tags: ['performance', 'database'], notes: notesJson([{ text: 'Found it — the connection pool was exhausted due to a missing connection release in the new middleware. Hotfix deployed.', days_ago: 0.5 }]), days_ago: 2, updated_ago: 0.5, completed_ago: 0.5 },
    ],
  },
];

/**
 * For multi-project demo scenarios, create and register additional projects.
 * Called from cli.ts after the server is running.
 */
export async function seedDemoExtraProjects(scenario: number, primaryDataDir: string, port: number): Promise<void> {
  // Multi-project demos: scenario 10 (tabs), scenario 12 (terminal dashboard),
  // scenario 13 (cross-project telemetry stats — HS-8682).
  if (scenario !== 10 && scenario !== 12 && scenario !== 13) return;

  const fs = await import('fs');
  const path = await import('path');
  const { registerProject } = await import('./projects.js');
  const { readFileSettings, writeFileSettings } = await import('./file-settings.js');
  const { getDb, getDbForDir } = await import('./db/connection.js');
  // HS-8688 — `registerProject` does NOT call `eagerSpawnTerminals` itself;
  // the primary project gets eager-spawned by `cli.ts:542` at startup, and
  // restored projects get it in `restorePreviousProjects`. Demo-mode extras
  // register OUTSIDE both paths, so without an explicit call the non-lazy
  // terminals stay un-spawned and the §25 dashboard tiles render as cold
  // "Not yet started" placeholders for Mobile App + API Platform forever.
  const { eagerSpawnTerminals } = await import('./terminals/eagerSpawn.js');

  const baseDir = path.dirname(primaryDataDir);
  // HS-8682 — capture each extra project's secret as we go so we can seed
  // per-project otel_metrics rows after all registrations complete (telemetry
  // tables live in the primary's shared DB per §67.6, keyed by project_secret).
  const extraSecrets: Array<{ secret: string; appName: string }> = [];

  for (const extra of EXTRA_PROJECTS) {
    const extraDataDir = path.join(baseDir, `${path.basename(primaryDataDir)}-${extra.appName.toLowerCase().replace(/\s+/g, '-')}`);
    fs.mkdirSync(extraDataDir, { recursive: true });

    // Get a DB instance directly for this specific data dir
    const db = await getDbForDir(extraDataDir);

    // Seed tickets
    for (let i = 0; i < extra.tickets.length; i++) {
      const t = extra.tickets[i];
      const ticketNumber = `HS-${i + 1}`;
      const createdAt = daysAgo(t.days_ago);
      const updatedAt = daysAgo(t.updated_ago);
      const completedAt = t.completed_ago !== undefined ? daysAgo(t.completed_ago) : null;
      const verifiedAt = t.verified_ago !== undefined ? daysAgo(t.verified_ago) : null;
      const tags = JSON.stringify(t.tags);

      await db.query(`
        INSERT INTO tickets (ticket_number, title, details, category, priority, status, up_next, notes, tags, created_at, updated_at, completed_at, verified_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $11::timestamp, $12::timestamp, $13::timestamp)
      `, [ticketNumber, t.title, t.details, t.category, t.priority, t.status, t.up_next, t.notes, tags, createdAt, updatedAt, completedAt, verifiedAt]);
    }
    await db.query(`SELECT setval('ticket_seq', $1)`, [extra.tickets.length]);

    // Settings: app name for every multi-project scenario; scenarios 12 + 13
    // layer in their own flags.
    const settings: Record<string, string | boolean> = { appName: extra.appName };
    if (scenario === 12) {
      const terminals = extra.appName === 'Mobile App'
        ? SCENARIO_12_MOBILE_TERMINALS
        : extra.appName === 'API Platform'
          ? SCENARIO_12_API_TERMINALS
          : [];
      if (terminals.length > 0) settings.terminals = JSON.stringify(terminals);
    }
    if (scenario === 13) {
      // HS-8682 — enable telemetry on each extra project so it appears in the
      // §70 cross-project rollup (the route filters by
      // `getAllProjects().map(p => p.secret)` per HS-8625; the rollup itself
      // includes any row whose project_secret is in that set).
      settings.telemetry_enabled = true;
    }
    writeFileSettings(extraDataDir, settings);

    // Register with the running server + capture the secret for scenario 13's
    // telemetry-row seeding below.
    const ctx = await registerProject(extraDataDir, port);
    // HS-8688 — eager-spawn the extra project's non-lazy terminals so the
    // §25 dashboard sees each tile as `state: 'alive'` when it first
    // mounts the grid. Without this the Mobile App + API Platform sections
    // of the dashboard render as cold "Not yet started" placeholders even
    // though the configs have `lazy: false`.
    eagerSpawnTerminals(ctx.secret, extraDataDir);
    if (scenario === 13) {
      extraSecrets.push({ secret: ctx.secret, appName: extra.appName });
    }
  }

  // HS-8682 — seed `otel_metrics` cost.usage rows once all 3 projects are
  // registered + their telemetry flags set. All rows go into the primary's
  // shared telemetry DB (per §67.6); each row carries its owning project's
  // `project_secret` so the cross-project page's per-project aggregates work.
  if (scenario === 13) {
    const primarySecret = readFileSettings(primaryDataDir).secret;
    if (typeof primarySecret === 'string' && primarySecret !== '') {
      const sharedDb = await getDb();
      // Primary first (index 0 → highest project-multiplier so the cost-by-
      // project table has a clear winner row).
      await seedDemoTelemetryRows(sharedDb, primarySecret, 0);
      let idx = 1;
      for (const { secret } of extraSecrets) {
        await seedDemoTelemetryRows(sharedDb, secret, idx);
        idx++;
      }
    }
  }
}
