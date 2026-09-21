export const EMAIL_SIGNAL_TYPES = [
    "email.client_docs",
    "email.invoice_unpaid",
    "email.dispute",
    "email.brand_deal",
    "email.lead",
    "email.revision",
    "email.noshow",
    "email.travel",
    "email.school",
    "email.supplier",
    "email.advisor",
    "email.order",
    "email.important",
] as const;

export type EmailSignalType = (typeof EMAIL_SIGNAL_TYPES)[number];

export type InboundEmailFields = {
    subject?: string;
    text?: string;
    html?: string;
    preview?: string;
    from?: string;
    attachmentCount?: number;
};

type ClassifierRule = {
    type: EmailSignalType;
    pattern: RegExp;
    enrich: (haystack: string, fields: InboundEmailFields) => Record<string, unknown>;
};

function firstNumber(haystack: string, pattern: RegExp): number | undefined {
    const match = pattern.exec(haystack);
    if (!match) {
        return undefined;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
}

function mentions(haystack: string, pattern: RegExp): boolean {
    return pattern.test(haystack);
}

const RULES: ClassifierRule[] = [
    {
        type: "email.client_docs",
        pattern:
            /\b(missing\s+docs?|missing\s+documents?|documents?\s+(needed|required|missing)|please\s+find\s+attached|please\s+send.{0,40}\b(docs?|documents?|pan|gst|kyc|statement|certificate)|\bpfa\b|kyc|form\s*16|itr\b|gst\s+(certificate|return|filing)|bank\s+statement|pan\s+card|client\s+docs?)\b/i,
        enrich: (haystack, fields) => {
            const counted = firstNumber(haystack, /(\d+)\s+(?:missing|pending)\s+(?:docs?|documents?)/i);
            const missingLanguage = mentions(haystack, /\b(missing|please\s+send|need(?:ed)?|pending)\b/i);
            const attachmentCount = fields.attachmentCount ?? 0;
            const missingDocs = counted ?? (missingLanguage && attachmentCount === 0 ? 1 : 0);
            return {
                missingDocs,
                complete: missingDocs === 0 && attachmentCount > 0,
                deadlineDays: firstNumber(haystack, /(?:due|deadline).{0,24}?(\d+)\s+days?/i),
            };
        },
    },
    {
        type: "email.invoice_unpaid",
        pattern: /\b(invoice|overdue|past\s+due|payment\s+due|unpaid)\b/i,
        enrich: (haystack) => ({
            daysOverdue: firstNumber(haystack, /(\d+)\s+days?\s+overdue/) ?? firstNumber(haystack, /overdue\s+(\d+)\s+days?/),
            amount: firstNumber(haystack, /(?:₹|rs\.?|inr)\s*([0-9]+(?:\.[0-9]+)?)/i) ?? firstNumber(haystack, /\$([0-9]+(?:\.[0-9]+)?)/),
            paid: mentions(haystack, /\b(paid in full|payment received|already paid)\b/i),
        }),
    },
    {
        type: "email.dispute",
        pattern: /\b(dispute|chargeback|evidence\s+pack)\b/i,
        enrich: (haystack, fields) => ({
            evidenceComplete: (fields.attachmentCount ?? 0) > 0,
            amount: firstNumber(haystack, /(?:₹|rs\.?|inr|\$)\s*([0-9]+(?:\.[0-9]+)?)/i),
            duplicate: mentions(haystack, /\b(duplicate|already filed)\b/i),
        }),
    },
    {
        type: "email.brand_deal",
        pattern: /\b(brand\s+deal|sponsorship|collab(?:oration)?|influencer)\b/i,
        enrich: (haystack) => ({
            budget: firstNumber(haystack, /(?:₹|rs\.?|inr|\$)\s*([0-9]+(?:\.[0-9]+)?)/i),
            exclusivity: mentions(haystack, /\bexclusiv/i),
            spam: mentions(haystack, /\b(unsubscribe|you(?:'| a)?re a winner)\b/i),
        }),
    },
    {
        type: "email.lead",
        pattern: /\b(site\s+visit|property\s+viewing|buyer\s+inquir|real\s+estate\s+lead)\b/i,
        enrich: (haystack) => ({
            qualified: mentions(haystack, /\b(pre[-\s]?approved|budget|ready to buy)\b/i),
            budgetKnown: mentions(haystack, /\b(budget|₹|inr|lakhs?)\b/i),
            spam: mentions(haystack, /\bunsubscribe\b/i),
        }),
    },
    {
        type: "email.revision",
        pattern: /\b(revision|scope\s+change|change\s+request)\b/i,
        enrich: (haystack) => ({
            withinScope: !mentions(haystack, /\b(out of scope|extra cost|additional fee)\b/i),
            extraCost: firstNumber(haystack, /(?:extra|additional)\s+(?:cost|fee).{0,12}?(?:₹|rs\.?|inr|\$)\s*([0-9]+(?:\.[0-9]+)?)/i) ?? 0,
            closed: mentions(haystack, /\b(closed|already shipped|won't change)\b/i),
        }),
    },
    {
        type: "email.noshow",
        pattern: /\b(no[-\s]?show|missed\s+(the\s+)?appointment|didn'?t\s+show)\b/i,
        enrich: (haystack) => ({
            firstMiss: !mentions(haystack, /\b(again|repeat|second|third)\b/i),
            repeatMisses: firstNumber(haystack, /(\d+)\s+(?:misses|no[-\s]?shows)/i) ?? (mentions(haystack, /\b(again|repeat)\b/i) ? 2 : 1),
            rescheduled: mentions(haystack, /\breschedul/i),
        }),
    },
    {
        type: "email.travel",
        pattern: /\b(flight|itinerary|boarding\s+pass|\bpnr\b|gate\s+change|delayed\s+flight)\b/i,
        enrich: (haystack) => ({
            delayMinutes: firstNumber(haystack, /delayed?\s+(?:by\s+)?(\d+)\s+(?:min|minutes)/i),
            informational: mentions(haystack, /\b(check[-\s]?in reminder|itinerary)\b/i) && !mentions(haystack, /\bdelay/i),
        }),
    },
    {
        type: "email.school",
        pattern: /\b(permission\s+slip|parent[-\s]?teacher|\bpta\b|school\s+(event|newsletter|trip))\b/i,
        enrich: (haystack) => ({
            permissionSlip: mentions(haystack, /\bpermission\s+slip\b/i),
            eventDays: firstNumber(haystack, /in\s+(\d+)\s+days?/),
            newsletter: mentions(haystack, /\bnewsletter\b/i),
        }),
    },
    {
        type: "email.supplier",
        pattern: /\b(supplier|shipment\s+delay|purchase\s+order)\b/i,
        enrich: (haystack) => ({
            delayHours: firstNumber(haystack, /(\d+)\s+hours?\s+(?:delay|late)/i) ?? firstNumber(haystack, /delayed?\s+(?:by\s+)?(\d+)\s+hours?/i),
            informational: mentions(haystack, /\b(fyi|for your information)\b/i),
        }),
    },
    {
        type: "email.advisor",
        pattern: /\b(advisor|thesis|supervisor|assignment\s+deadline)\b/i,
        enrich: (haystack) => ({
            deadlineDays: firstNumber(haystack, /(?:due|deadline).{0,24}?(\d+)\s+days?/i),
            fyi: mentions(haystack, /\b(fyi|for your information)\b/i),
        }),
    },
    {
        type: "email.order",
        pattern: /\b(order\s+(?:#|number|confirmation)|cake\s+order|bakery)\b/i,
        enrich: (haystack) => ({
            orderCount: firstNumber(haystack, /(\d+)\s+orders?/) ?? 1,
            dueToday: mentions(haystack, /\b(due today|needed today)\b/i),
        }),
    },
];

function importantPayload(haystack: string): Record<string, unknown> {
    return {
        fromInvestor: mentions(haystack, /\b(investor|\bvc\b|venture capital)\b/i),
        legal: mentions(haystack, /\b(legal|attorney|counsel|\bnda\b)\b/i),
        newsletter: mentions(haystack, /\b(unsubscribe|newsletter)\b/i),
    };
}

export function classifyInboundEmail(fields: InboundEmailFields): {
    type: EmailSignalType;
    payload: Record<string, unknown>;
} {
    const haystack = [fields.subject, fields.text, fields.preview, fields.from, fields.html]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n");

    for (const rule of RULES) {
        if (!rule.pattern.test(haystack)) {
            continue;
        }
        return {
            type: rule.type,
            payload: rule.enrich(haystack, fields),
        };
    }

    return {
        type: "email.important",
        payload: importantPayload(haystack),
    };
}
