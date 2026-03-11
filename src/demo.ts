import { getDb } from './db/connection.js';

// --- Scenario definitions ---

export interface DemoScenario {
  id: number;
  label: string;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  { id: 1, label: 'Main UI — all tickets with detail panel' },
  { id: 2, label: 'Quick entry — bullet-list ticket creation' },
  { id: 3, label: 'Sidebar filtering — category view' },
  { id: 4, label: 'AI worklist — Up Next tickets with notes' },
  { id: 5, label: 'Batch operations — multi-select toolbar' },
  { id: 6, label: 'Detail panel — bottom orientation with notes' },
  { id: 7, label: 'Column view — kanban board by status' },
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

function notesJson(entries: { text: string; days_ago: number }[]): string {
  if (entries.length === 0) return '';
  return JSON.stringify(entries.map(e => ({ text: e.text, created_at: daysAgo(e.days_ago) })));
}

// --- Scenario 1: Hero — main UI with all tickets ---
// Shows: variety of categories, priorities, statuses, some up_next, detail panel content

const SCENARIO_1: DemoTicket[] = [
  {
    title: 'Fix checkout failing when cart has mixed shipping methods',
    details: 'When a cart contains items with different shipping methods (standard + express), the checkout process fails at the shipping calculation step.\n\nSteps to reproduce:\n1. Add an item with standard shipping\n2. Add an item with express-only shipping\n3. Proceed to checkout\n4. Error at shipping step: "Unable to calculate shipping"\n\nLikely issue is in ShippingCalculator.consolidate() which assumes a single method.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    notes: notesJson([{ text: 'Confirmed the issue is in ShippingCalculator.consolidate(). It uses a single rate lookup instead of per-item calculation. Working on a fix that groups items by shipping method and merges the rates.', days_ago: 0.5 }]),
    days_ago: 5, updated_ago: 0.5,
  },
  {
    title: 'Add product comparison view for category pages',
    details: 'Users should be able to select 2-4 products and see a side-by-side comparison table showing specs, price, ratings, and availability.',
    category: 'feature', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Set up automated database backups to S3',
    details: 'Configure daily pg_dump backups with 30-day retention. Use the existing AWS credentials from the infra stack. Should run at 03:00 UTC.',
    category: 'task', priority: 'high', status: 'started', up_next: true,
    notes: notesJson([{ text: 'Created the backup script and IAM role. Testing the S3 lifecycle policy for retention.', days_ago: 1 }]),
    days_ago: 7, updated_ago: 1,
  },
  {
    title: 'Evaluate Stripe vs Square for payment processing',
    details: 'Compare fees, API quality, international support, and dispute handling. We need a recommendation by end of sprint.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Product images not loading on slow connections',
    details: 'Users on 3G connections report broken product images. Likely need progressive loading and proper srcset/sizes attributes.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Allow customers to save multiple shipping addresses',
    details: 'Currently limited to one address. Users should be able to store and label multiple addresses (Home, Work, etc.) and pick during checkout.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 10, updated_ago: 10,
  },
  {
    title: 'Update tax calculation to handle EU VAT rules',
    details: 'Need to support reverse charge for B2B and country-specific VAT rates. The current flat-rate approach is incorrect for EU customers.',
    category: 'requirement_change', priority: 'default', status: 'started', up_next: false,
    notes: '', days_ago: 8, updated_ago: 2,
  },
  {
    title: 'Write API documentation for order endpoints',
    details: 'Document all /api/orders/* endpoints with request/response examples using OpenAPI 3.0 format.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Documented all 12 order endpoints with examples. Published to /docs.', days_ago: 1 }]),
    days_ago: 12, updated_ago: 1, completed_ago: 1,
  },
  {
    title: 'Fix CORS headers blocking mobile app API requests',
    details: 'The mobile app gets CORS errors on preflight OPTIONS requests. Need to add proper Access-Control headers for the mobile origin.',
    category: 'bug', priority: 'highest', status: 'verified', up_next: false,
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
    notes: '', days_ago: 15, updated_ago: 15,
  },
  {
    title: 'Migrate to connection pooling for database',
    details: 'Switch from individual connections to pgBouncer or built-in pooling. Current approach is causing connection exhaustion under load.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Migrated to pg pool with max 20 connections. Load tested successfully at 500 concurrent requests.', days_ago: 4 }]),
    days_ago: 18, updated_ago: 4, completed_ago: 4,
  },
  {
    title: 'Research SSR frameworks for product pages',
    details: 'Evaluate Next.js, Remix, and Astro for SEO-critical product pages. Need to consider hydration cost and build complexity.',
    category: 'investigation', priority: 'lowest', status: 'not_started', up_next: false,
    notes: '', days_ago: 20, updated_ago: 20,
  },
];

// --- Scenario 2: Quick entry — few tickets, focus on draft row ---

const SCENARIO_2: DemoTicket[] = [
  {
    title: 'Fix login redirect loop after session timeout',
    details: 'After session timeout, the redirect goes to /login?next=/login which creates an infinite loop.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Add CSV export for order reports',
    details: 'Admin users need to export filtered order data as CSV for accounting.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Update dependencies to latest versions',
    details: 'Several packages have security patches available. Run npm audit and update.',
    category: 'task', priority: 'default', status: 'started', up_next: false,
    notes: '', days_ago: 1, updated_ago: 0.5,
  },
];

// --- Scenario 3: Sidebar filtering — many categories for meaningful filters ---

const SCENARIO_3: DemoTicket[] = [
  {
    title: 'Fix checkout totals rounding incorrectly on multi-item carts',
    details: 'Subtotals accumulate floating-point errors. Use integer cents for all calculations.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    notes: '', days_ago: 3, updated_ago: 1,
  },
  {
    title: 'Search returns stale results after product update',
    details: 'The search index isn\'t being refreshed when product details change. Need to trigger re-index on product save.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Email notifications sent with wrong timezone offset',
    details: 'All notification timestamps show UTC instead of the user\'s configured timezone.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Implement real-time inventory tracking',
    details: 'Use WebSocket connections to push stock level changes to the product page. Show "Only X left" badges.',
    category: 'feature', priority: 'high', status: 'started', up_next: true,
    notes: notesJson([{ text: 'WebSocket server is set up. Working on the client-side stock badge component.', days_ago: 0.5 }]),
    days_ago: 6, updated_ago: 0.5,
  },
  {
    title: 'Add wishlist sharing via email',
    details: 'Users can generate a shareable link or send their wishlist directly to an email address.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 9, updated_ago: 9,
  },
  {
    title: 'Product video support on detail pages',
    details: 'Allow merchants to upload product videos alongside photos. Support mp4 and embedded YouTube URLs.',
    category: 'feature', priority: 'low', status: 'not_started', up_next: false,
    notes: '', days_ago: 12, updated_ago: 12,
  },
  {
    title: 'Migrate image storage to CDN',
    details: 'Move product images from local disk to CloudFront. Needs URL rewriting for existing images.',
    category: 'task', priority: 'high', status: 'started', up_next: false,
    notes: '', days_ago: 4, updated_ago: 2,
  },
  {
    title: 'Set up error monitoring with Sentry',
    details: 'Configure Sentry for both server and client-side error tracking. Set up alert rules for critical errors.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Sentry configured for Node.js backend and React frontend. Alert rules set for 5xx errors.', days_ago: 3 }]),
    days_ago: 10, updated_ago: 3, completed_ago: 3,
  },
  {
    title: 'Support guest checkout without account creation',
    details: 'High-priority requirement change from product. Many users abandon at the registration step. Allow checkout with just email.',
    category: 'requirement_change', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Update return policy to 60-day window',
    details: 'Legal team requires extending the return window from 30 to 60 days. Update all customer-facing copy and the returns API logic.',
    category: 'requirement_change', priority: 'default', status: 'started', up_next: false,
    notes: '', days_ago: 8, updated_ago: 3,
  },
  {
    title: 'Compare Redis vs Memcached for session storage',
    details: 'Current in-memory sessions don\'t survive restarts. Evaluate Redis and Memcached for persistence, speed, and ops complexity.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: false,
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Analyze mobile conversion drop-off funnel',
    details: 'Mobile users convert at 1.2% vs 3.8% desktop. Investigate where in the funnel mobile users are dropping off.',
    category: 'investigation', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 11, updated_ago: 11,
  },
];

// --- Scenario 4: AI worklist — Up Next tickets with progress notes ---

const SCENARIO_4: DemoTicket[] = [
  {
    title: 'Fix race condition in concurrent order placement',
    details: 'When two orders are placed simultaneously for the last item in stock, both succeed and inventory goes negative.\n\nNeed to add row-level locking in OrderService.place() or use a serializable transaction.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
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
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Add input validation to all public API endpoints',
    details: 'Several endpoints accept unvalidated input. Add zod schemas for request bodies and query params on all /api/* routes.',
    category: 'task', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Fix decimal precision loss in price calculations',
    details: 'Prices stored as NUMERIC(10,2) but JavaScript floating-point math causes rounding errors in totals. Convert all price math to integer cents.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: true,
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Evaluate caching strategies for product catalog',
    details: 'Product pages are slow under load. Investigate Redis caching, CDN edge caching, and stale-while-revalidate patterns. Need to maintain cache coherency on product updates.',
    category: 'investigation', priority: 'default', status: 'not_started', up_next: true,
    notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Add bulk product import from CSV',
    details: 'Merchants need to upload a CSV of products to create/update inventory in batch. Support create, update, and skip-on-conflict modes.',
    category: 'feature', priority: 'low', status: 'completed', up_next: false,
    notes: notesJson([
      { text: 'Implemented CSV parser using papaparse. Supports create and update modes with duplicate detection by SKU.', days_ago: 3 },
      { text: 'Added validation for required fields (name, price, SKU) and friendly error messages with row numbers for malformed data.', days_ago: 2 },
    ]),
    days_ago: 10, updated_ago: 2, completed_ago: 2,
  },
  {
    title: 'Normalize database schema for customer addresses',
    details: 'Addresses are currently embedded as JSON in the customers table. Extract to a separate addresses table with proper foreign keys.',
    category: 'task', priority: 'default', status: 'verified', up_next: false,
    notes: notesJson([
      { text: 'Created migration to extract addresses into a new table. Backfilled 12,400 existing address records.', days_ago: 5 },
      { text: 'Verified the migration ran correctly. All address lookups use the new table. Old JSON column can be dropped in next release.', days_ago: 3 },
    ]),
    days_ago: 14, updated_ago: 3, completed_ago: 5, verified_ago: 3,
  },
];

// --- Scenario 5: Batch operations — many similar tickets to batch-select ---

const SCENARIO_5: DemoTicket[] = [
  {
    title: 'Fix email template rendering in Outlook',
    details: 'Order confirmation emails break in Outlook due to unsupported CSS flexbox. Use table-based layout.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Handle timeout on third-party shipping rate API',
    details: 'When the shipping provider API times out, the checkout page shows a generic 500 error. Show a retry prompt instead.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Fix pagination on search results page',
    details: 'Page 2+ of search results shows duplicate items. The OFFSET calculation is wrong when filters change.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Cart badge count not updating after item removal',
    details: 'The header cart icon shows the old count until a full page refresh. The client state isn\'t being updated.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: false,
    notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Add order tracking page for customers',
    details: 'Customers need a page showing shipment status, tracking number, and estimated delivery. Pull data from the shipping provider API.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 6, updated_ago: 6,
  },
  {
    title: 'Implement product review moderation queue',
    details: 'Admin interface to approve/reject/flag user reviews before they appear publicly.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 7, updated_ago: 7,
  },
  {
    title: 'Add rate limiting to public API endpoints',
    details: 'Protect against abuse with per-IP rate limiting. Use a sliding window algorithm. Target: 100 req/min for anonymous, 500 for authenticated.',
    category: 'task', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 8, updated_ago: 8,
  },
  {
    title: 'Set up staging environment on AWS',
    details: 'Mirror production setup with smaller instances. Auto-deploy from the develop branch.',
    category: 'task', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 9, updated_ago: 9,
  },
  {
    title: 'Clean up unused CSS classes from redesign',
    details: 'The recent redesign left ~40 unused CSS classes. Run PurgeCSS and remove dead code.',
    category: 'task', priority: 'low', status: 'not_started', up_next: false,
    notes: '', days_ago: 12, updated_ago: 12,
  },
  {
    title: 'Archive completed migration files older than 6 months',
    details: 'Move old migration files to an archive directory to keep the migrations folder manageable.',
    category: 'task', priority: 'low', status: 'not_started', up_next: false,
    notes: '', days_ago: 14, updated_ago: 14,
  },
];

// --- Scenario 6: Detail panel bottom with rich notes ---

const SCENARIO_6: DemoTicket[] = [
  {
    title: 'Implement real-time order tracking with WebSockets',
    details: 'Build a live order tracking view that pushes status updates to the customer in real-time.\n\nRequirements:\n- WebSocket connection per active order\n- Status events: confirmed, preparing, shipped, out_for_delivery, delivered\n- Reconnect logic with exponential backoff\n- Fallback to polling for browsers without WebSocket support\n\nThe tracking page should show a visual timeline with the current step highlighted.',
    category: 'feature', priority: 'highest', status: 'started', up_next: true,
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
    notes: notesJson([{ text: 'Heap snapshot shows the BatchProcessor holding references to completed batches. The onComplete callbacks are never cleaned up.', days_ago: 1 }]),
    days_ago: 5, updated_ago: 1,
  },
  {
    title: 'Add comprehensive test coverage for payment flow',
    details: 'The payment processing flow has no integration tests. Add tests covering: successful payment, declined card, network timeout, partial refund, and currency conversion.',
    category: 'task', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Add product recommendations based on purchase history',
    details: 'Show "Customers also bought" recommendations on product pages using collaborative filtering on order history.',
    category: 'feature', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([
      { text: 'Implemented a simple collaborative filtering algorithm. Computes item-item similarity from co-purchase frequency in the last 90 days.', days_ago: 5 },
      { text: 'Added the recommendations API endpoint and the product page widget. Limited to 4 recommendations. Recalculation runs nightly via cron.', days_ago: 3 },
    ]),
    days_ago: 12, updated_ago: 3, completed_ago: 3,
  },
  {
    title: 'Migrate static assets to CDN',
    details: 'Product images, CSS, and JS bundles should be served from CloudFront. Reduces server load and improves page load times globally.',
    category: 'task', priority: 'default', status: 'verified', up_next: false,
    notes: notesJson([
      { text: 'Configured CloudFront distribution with S3 origin. Migrated all product images (42GB) using the AWS CLI sync command.', days_ago: 7 },
      { text: 'Updated asset URLs in the application to use the CDN domain. Cache hit rate is at 94% after 48 hours. TTFB improved from 240ms to 35ms for static assets.', days_ago: 5 },
    ]),
    days_ago: 16, updated_ago: 5, completed_ago: 7, verified_ago: 5,
  },
  {
    title: 'Fix broken breadcrumb links on category pages',
    details: 'Nested category breadcrumbs link to the wrong parent when the category tree is more than 3 levels deep.',
    category: 'bug', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 8, updated_ago: 8,
  },
];

// --- Scenario 7: Column view — kanban board with good spread across statuses ---

const SCENARIO_7: DemoTicket[] = [
  {
    title: 'Implement product search autocomplete',
    details: 'Add typeahead suggestions to the search bar using the product name index. Show top 5 matches with thumbnails.',
    category: 'feature', priority: 'highest', status: 'not_started', up_next: true,
    notes: '', days_ago: 2, updated_ago: 2,
  },
  {
    title: 'Fix broken password reset flow for SSO users',
    details: 'SSO users who try to reset their password get a generic error. Should redirect them to their identity provider instead.',
    category: 'bug', priority: 'high', status: 'not_started', up_next: true,
    notes: '', days_ago: 3, updated_ago: 3,
  },
  {
    title: 'Add support for gift cards at checkout',
    details: 'Customers should be able to apply gift card codes during checkout. Support partial redemption and balance tracking.',
    category: 'feature', priority: 'default', status: 'not_started', up_next: false,
    notes: '', days_ago: 5, updated_ago: 5,
  },
  {
    title: 'Investigate slow query on order history page',
    details: 'The order history page takes 4+ seconds for users with 200+ orders. Profile the query and add proper indexing.',
    category: 'investigation', priority: 'high', status: 'not_started', up_next: false,
    notes: '', days_ago: 4, updated_ago: 4,
  },
  {
    title: 'Refactor authentication middleware to support API keys',
    details: 'Third-party integrations need API key auth in addition to session cookies. Extract auth into a strategy pattern.',
    category: 'task', priority: 'high', status: 'started', up_next: true,
    notes: notesJson([{ text: 'Created the AuthStrategy interface and migrated session auth to use it. Working on the API key strategy next.', days_ago: 0.5 }]),
    days_ago: 4, updated_ago: 0.5,
  },
  {
    title: 'Fix cart not clearing after successful checkout',
    details: 'After a successful order placement, the cart retains all items. The clearCart() call is inside a catch block by mistake.',
    category: 'bug', priority: 'highest', status: 'started', up_next: true,
    notes: notesJson([{ text: 'Found the issue — clearCart() was moved into the catch block during a refactor. Fixing and adding a test.', days_ago: 0.3 }]),
    days_ago: 1, updated_ago: 0.3,
  },
  {
    title: 'Update shipping rate calculation for oversized items',
    details: 'Dimensional weight pricing is required for packages over 1 cubic foot. Current flat-rate calculation undercharges.',
    category: 'requirement_change', priority: 'default', status: 'started', up_next: false,
    notes: notesJson([{ text: 'Implemented dim weight formula. Comparing rates against the carrier API to validate accuracy.', days_ago: 1 }]),
    days_ago: 6, updated_ago: 1,
  },
  {
    title: 'Add end-to-end tests for the checkout flow',
    details: 'Write Playwright tests covering: add to cart, apply coupon, enter shipping, pay, and confirm. Cover happy path and key error cases.',
    category: 'task', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Wrote 8 E2E tests covering the full checkout flow including coupon application and payment decline handling.', days_ago: 1 }]),
    days_ago: 8, updated_ago: 1, completed_ago: 1,
  },
  {
    title: 'Fix product image carousel swipe on mobile',
    details: 'Swipe gestures on the product image carousel conflict with the browser back gesture. Use a swipe threshold to disambiguate.',
    category: 'bug', priority: 'default', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Added a 30px horizontal threshold before initiating carousel swipe. Tested on iOS Safari and Chrome Android.', days_ago: 2 }]),
    days_ago: 7, updated_ago: 2, completed_ago: 2,
  },
  {
    title: 'Set up log aggregation with structured JSON logging',
    details: 'Replace console.log calls with a structured logger (pino). Send logs to a central aggregation service for search and alerting.',
    category: 'task', priority: 'low', status: 'completed', up_next: false,
    notes: notesJson([{ text: 'Replaced all console.log calls with pino. Configured log shipping to the aggregation service. Alert rules set for error-level logs.', days_ago: 3 }]),
    days_ago: 10, updated_ago: 3, completed_ago: 3,
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
};

// --- Seeding ---

export async function seedDemoData(scenario: number): Promise<void> {
  const db = await getDb();
  const tickets = SCENARIO_DATA[scenario];
  if (!tickets) return;

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    const ticketNumber = `HS-${i + 1}`;
    const createdAt = daysAgo(t.days_ago);
    const updatedAt = daysAgo(t.updated_ago);
    const completedAt = t.completed_ago !== undefined ? daysAgo(t.completed_ago) : null;
    const verifiedAt = t.verified_ago !== undefined ? daysAgo(t.verified_ago) : null;

    await db.query(`
      INSERT INTO tickets (ticket_number, title, details, category, priority, status, up_next, notes, created_at, updated_at, completed_at, verified_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10::timestamp, $11::timestamp, $12::timestamp)
    `, [ticketNumber, t.title, t.details, t.category, t.priority, t.status, t.up_next, t.notes, createdAt, updatedAt, completedAt, verifiedAt]);
  }

  // Advance the sequence past seeded tickets so new ones don't collide
  await db.query(`SELECT setval('ticket_seq', $1)`, [tickets.length]);

  // Scenario-specific settings
  if (scenario === 6) {
    await db.query(`UPDATE settings SET value = 'bottom' WHERE key = 'detail_position'`);
    await db.query(`UPDATE settings SET value = '280' WHERE key = 'detail_height'`);
  }
  if (scenario === 7) {
    await db.query(`INSERT INTO settings (key, value) VALUES ('layout', 'columns') ON CONFLICT (key) DO UPDATE SET value = 'columns'`);
  }
}
