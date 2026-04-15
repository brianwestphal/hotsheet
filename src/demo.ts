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
  if (scenario === 3) {
    writeProjectSettings(dataDir, { custom_views: JSON.stringify(SCENARIO_3_VIEWS) });
  }
  if (scenario === 6) {
    writeProjectSettings(dataDir, { detail_position: 'bottom', detail_height: '280' });
  }
  if (scenario === 7) {
    writeProjectSettings(dataDir, { layout: 'columns' });
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
}

// --- Scenario 10: Multi-project tabs — extra projects ---

interface ExtraProject {
  appName: string;
  tickets: DemoTicket[];
}

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
  if (scenario !== 10) return;

  const fs = await import('fs');
  const path = await import('path');
  const { registerProject } = await import('./projects.js');
  const { writeFileSettings } = await import('./file-settings.js');
  const { getDbForDir } = await import('./db/connection.js');

  const baseDir = path.dirname(primaryDataDir);

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

    // Set app name
    writeFileSettings(extraDataDir, { appName: extra.appName });

    // Register with the running server
    await registerProject(extraDataDir, port);
  }
}
