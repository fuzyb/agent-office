// The one kind of change the office never merges unattended: billing, payments, subscriptions, spending and
// financial commitments. Everything else the owner allows (code, infrastructure, security, dependencies, CI) may be
// merged without a person once it is verified; this may not, and nothing in a policy, an approval or a review
// changes that. It is decided by plain code from three things, and ANY one of them is enough:
//   1. the changed PATHS (a folder or file named for billing, payments, pricing, a payment processor...);
//   2. the TITLE;
//   3. the changed LINES of the diff (a payment processor, a billing or payment term, a spending or budget term, a
//      paid API or provisioned cloud resource, a live payment key), including lines that are removed, since removing
//      a payment check is as much a change as adding one.
// It is deliberately broad: a false alarm costs one person's merge, a miss spends money. When the diff cannot be
// read at all, the caller treats that as "a person decides" too.
//
// Browser-safe: no node imports.

const SEG = '(^|/)';
const END = '([/._-]|$)';

const PATHS: RegExp[] = [
  new RegExp(`${SEG}(billing|payments?|payouts?|checkout|subscriptions?|invoices?|pricing|prices?|refunds?|chargebacks?|paywall|wallets?|ledger|monetiz\\w*|spend(ing)?|budgets?|purchas\\w*|credits?)${END}`, 'i'),
  new RegExp(`${SEG}(stripe|paypal|paddle|braintree|adyen|razorpay|chargebee|recurly|lemon-?squeezy|klarna|mollie|gocardless|plaid|coinbase|bitpay|shopify|paystack|flutterwave|mercadopago|alipay|venmo)${END}`, 'i'),
];

const PROCESSORS = 'stripe|paypal|braintree|paddle|adyen|razorpay|chargebee|recurly|lemon ?squeezy|klarna|mollie|gocardless|authorize\\.net|checkout\\.com|worldpay|squareup|plaid|coinbase|bitpay|apple ?pay|google ?pay|venmo|cash ?app|payoneer|2checkout|twocheckout|paystack|flutterwave|mercadopago|alipay|wechat ?pay|shopify';

const WORDS: [string, RegExp][] = [
  ['a payment processor', new RegExp(`\\b(${PROCESSORS})(?![a-z])`, 'i')],
  ['a live payment key', /\b(sk|pk|rk)_(live|test)_\w+|\bwhsec_\w+/i],
  ['billing or payments', /\b(billing|billed|invoices?|payments?|payouts?|refunds?|chargebacks?|credit[ _-]?cards?|debit[ _-]?cards?|card[ _-]?number|cvv|cvc|iban|bank[ _-]?account|routing[ _-]?number|wire[ _-]?transfer|direct[ _-]?debit|payment[ _-]?intent|price[ _-]?id|checkout[ _-]?session|paywall)\b/i],
  ['subscriptions or pricing', /\b(subscriptions?|subscribe[ _-]?to[ _-]?a?[ _-]?plan|paid[ _-]?plans?|pricing|free[ _-]?trial|trial[ _-]?ends?|upgrade[ _-]?your[ _-]?plan|pay[ _-]?as[ _-]?you[ _-]?go|metered|usage[ _-]?based)\b/i],
  ['spending or purchases', /\b(spend(ing)?|budgets?|purchases?|purchasing|buy[ _-]?credits|top[ _-]?up|credit[ _-]?balance|reserved[ _-]?instances?|savings[ _-]?plans?|cost[ _-]?cap|spend[ _-]?cap)\b/i],
  ['a paid API or credit-spending service', /api\.(anthropic|openai|mistral|cohere|together|groq|replicate|elevenlabs|deepseek)\.(com|ai|xyz)|generativelanguage\.googleapis\.com|openrouter\.ai|@anthropic-ai\/sdk|(from|require\()\s*['"](openai|@anthropic-ai\/sdk|@google\/generative-ai|cohere-ai|replicate|elevenlabs)['"]|\b(higgsfield|elevenlabs|runpod|vast\.ai)\b/i],
  ['provisioned cloud resources', /\bresource\s+"(aws|google|azurerm|digitalocean|linode|vultr|hcloud|oci|alicloud)_|AWS::[A-Z]\w+::[A-Z]\w+|\binstance[_-]?type\b/i],
];

/** camelCase and snake_case split into words, so `monthlyBudget` and `payment_intent` are seen as the words they are. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
const hit = (re: RegExp, s: string) => re.test(s) || re.test(words(s));

/** A changed line worth keeping as evidence, trimmed. */
const snippet = (line: string) => line.replace(/\s+/g, ' ').trim().slice(0, 80);

export interface FinancialInput {
  /** Changed paths, when known. */
  files?: readonly string[];
  title?: string;
  /** The unified diff of the change, when it could be read. */
  diff?: string;
}

/**
 * Why this change touches billing, payments, subscriptions or spending: every reason, empty when nothing does.
 * Looks at paths, the title and every added or removed line of the diff.
 */
export function financialReasons(input: FinancialInput): string[] {
  const why: string[] = [];
  const paths = (input.files ?? []).filter((f) => PATHS.some((re) => re.test(f)));
  if (paths.length) why.push(`it changes paths named for billing, payments, subscriptions or spending:${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ` and ${paths.length - 4} more` : ''}`);
  if (input.title) {
    const t = WORDS.find(([, re]) => hit(re, input.title!));
    if (t) why.push(`its title mentions ${t[0]}`);
  }
  if (input.diff) {
    const found = new Map<string, string>();
    for (const line of input.diff.split('\n')) {
      // Changed lines only (added or removed), and the file headers, which carry the old and the new path of a rename.
      const header = line.startsWith('diff --git ');
      if (header) {
        const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (m && (PATHS.some((re) => re.test(m[1])) || PATHS.some((re) => re.test(m[2])))) found.set('paths', snippet(`${m[1]} → ${m[2]}`));
        continue;
      }
      if (!(line.startsWith('+') || line.startsWith('-')) || line.startsWith('+++') || line.startsWith('---')) continue;
      for (const [name, re] of WORDS) if (!found.has(name) && hit(re, line)) found.set(name, snippet(line.slice(1)));
    }
    for (const [name, line] of found) why.push(name === 'paths' ? `its diff renames or changes billing-related paths (${line})` : `its changed lines mention ${name}: “${line}”`);
  }
  return why;
}
