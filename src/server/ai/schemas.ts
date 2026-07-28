import { z } from 'zod';

/**
 * Every schema below is written for Anthropic strict tool mode:
 *   - every object sets additionalProperties: false
 *   - every property is listed in `required`
 *   - nothing is nullable; "unknown" is expressed as "" or []
 * Numeric/length constraints are deliberately omitted (unsupported in strict mode);
 * the zod validators alongside them do that work client-side.
 */

const strictObject = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const enumOf = (values: string[], description: string) => ({
  type: 'string',
  enum: values,
  description,
});

export const SOURCE_KINDS = [
  'meeting_minutes',
  'rfp_portal',
  'bid_board',
  'permits',
  'zoning',      // site plan / variance / conditional use filings — where private retail rollout shows first
  'capital_plan',
  'news',        // local and trade press
  'corporate',   // company press releases, investor decks, franchise disclosure documents
  'real_estate', // brokerage and CRE announcements, build-to-suit listings
  'association',
  'other',
] as const;

export const FACT_CATEGORIES = [
  'timeline',
  'budget',
  'company',
  'contact',
  'detail',
  'milestone',
] as const;

/* ------------------------------------------------------------------ */
/* Work-type planning                                                  */
/* ------------------------------------------------------------------ */

export const workTypePlanSchema = strictObject({
  keywords: {
    type: 'array',
    description: 'Search terms and phrases that identify this kind of work in documents.',
    items: str('One keyword or short phrase.'),
  },
  lead_signals: {
    type: 'array',
    description:
      'The earliest observable public signals that this kind of work is coming, in rough chronological order.',
    items: str('One signal, e.g. "conditional use permit application filed for a drive-through site".'),
  },
  source_strategy: str(
    'Two to five sentences on where this specific kind of work surfaces publicly, and why. Be concrete about document and site types.',
  ),
  exclusions: str(
    'What commonly looks like this kind of work but should NOT be treated as a lead. Empty string if nothing obvious.',
  ),
  suggested_source_kinds: {
    type: 'array',
    description: 'Which source categories are most productive for this work type.',
    items: enumOf([...SOURCE_KINDS], 'A source category.'),
  },
});

export const workTypePlanValidator = z.object({
  keywords: z.array(z.string()).max(40),
  lead_signals: z.array(z.string()).max(20),
  source_strategy: z.string(),
  exclusions: z.string(),
  suggested_source_kinds: z.array(z.enum(SOURCE_KINDS)).max(11),
});
export type WorkTypePlan = z.infer<typeof workTypePlanValidator>;

/* ------------------------------------------------------------------ */
/* Source discovery                                                    */
/* ------------------------------------------------------------------ */

export const discoverySchema = strictObject({
  sources: {
    type: 'array',
    description: 'Lead sources worth monitoring. Empty array if none found.',
    items: strictObject({
      name: str('Human-readable name, e.g. "Ascension Parish Council Agendas".'),
      url: str('Direct URL to the page that lists items over time. Prefer a listing/index page over a single document.'),
      kind: enumOf([...SOURCE_KINDS], 'What type of source this is.'),
      jurisdiction: str('City, parish, county, or agency this covers. Empty string if not applicable.'),
      description: str('One or two sentences on what is published here and how often.'),
      reason: str('Why this source is likely to surface projects matching the profile.'),
      work_type_keys: {
        type: 'array',
        description:
          'Keys of the work types this source serves, taken exactly from the work type list given to you. Empty array only if no work types were listed.',
        items: str('One work type key.'),
      },
      confidence: int('0-100: how confident you are that this URL exists and is the right page.'),
    }),
  },
});

export const discoveryValidator = z.object({
  sources: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().url(),
        kind: z.enum(SOURCE_KINDS),
        jurisdiction: z.string(),
        description: z.string(),
        reason: z.string(),
        work_type_keys: z.array(z.string()).max(20),
        confidence: z.number().int().min(0).max(100),
      }),
    )
    .max(40),
});
export type DiscoveryResult = z.infer<typeof discoveryValidator>;

/* ------------------------------------------------------------------ */
/* Coverage assessment                                                 */
/* ------------------------------------------------------------------ */

export const assessmentSchema = strictObject({
  verdict: enumOf(
    ['adequate', 'needs_more_sources', 'needs_pruning'],
    'Overall judgement of the current source set.',
  ),
  reasoning: str('Two to four sentences explaining the verdict.'),
  coverage_gaps: {
    type: 'array',
    description: 'Specific gaps, e.g. a jurisdiction or source type not covered. Empty if none.',
    items: str('One gap, phrased as something to go look for.'),
  },
  suggested_searches: {
    type: 'array',
    description: 'Concrete search directions to close the gaps. Empty if none needed.',
    items: str('One search direction.'),
  },
  keywords: {
    type: 'array',
    description: 'Refined keyword list describing the target work, for use when scanning sources.',
    items: str('One keyword or short phrase.'),
  },
  jurisdictions: {
    type: 'array',
    description: 'Cities, parishes, counties, and agencies that fall inside the search radius.',
    items: str('One jurisdiction name.'),
  },
  sources_to_retire: {
    type: 'array',
    description: 'IDs of listed sources that should be retired as unproductive or wrong. Empty if none.',
    items: strictObject({
      source_id: str('The id exactly as given in the source list.'),
      reason: str('Why it should be retired.'),
    }),
  },
});

export const assessmentValidator = z.object({
  verdict: z.enum(['adequate', 'needs_more_sources', 'needs_pruning']),
  reasoning: z.string(),
  coverage_gaps: z.array(z.string()).max(20),
  suggested_searches: z.array(z.string()).max(20),
  keywords: z.array(z.string()).max(40),
  jurisdictions: z.array(z.string()).max(60),
  sources_to_retire: z
    .array(z.object({ source_id: z.string(), reason: z.string() }))
    .max(30),
});
export type AssessmentResult = z.infer<typeof assessmentValidator>;

/* ------------------------------------------------------------------ */
/* Source scan                                                         */
/* ------------------------------------------------------------------ */

export const scanSchema = strictObject({
  source_health: enumOf(
    ['ok', 'empty', 'unreachable', 'wrong_content'],
    'Whether the source page loaded and contained the kind of content expected.',
  ),
  notes: str('Short note about what this scan saw. Mention paging/date range covered.'),
  projects: {
    type: 'array',
    description: 'Distinct construction/design projects found. Empty array if none.',
    items: strictObject({
      name: str('The project name as it appears, or a concise descriptive name.'),
      summary: str('Two or three sentences: what is being built or planned, and for whom.'),
      project_type: str('e.g. "K-12 school", "municipal library", "fire station", "multifamily".'),
      stage: str('e.g. "feasibility", "planning", "RFQ issued", "design", "bidding", "under construction".'),
      address: str('Street address or best available location description. Empty if unknown.'),
      jurisdiction: str('City/parish/county/agency responsible. Empty if unknown.'),
      owner_org: str('Owner or issuing agency. Empty if unknown.'),
      estimated_value: str('Budget or contract value as stated, e.g. "$12.5M". Empty if unstated.'),
      timeline_note: str('Any dates or schedule info stated. Empty if none.'),
      evidence_url: str('URL of the specific page or document this came from.'),
      evidence_quote: str('A short verbatim quote from the source supporting this entry.'),
      work_type_key: str(
        'The key of the work type this project belongs to, taken exactly from the work type list. Use "" only if it genuinely matches none of them.',
      ),
      relevance: int('0-100: how well this fits the firm profile described.'),
      confidence: int('0-100: how confident you are this is a real, current project.'),
    }),
  },
});

export const scanValidator = z.object({
  source_health: z.enum(['ok', 'empty', 'unreachable', 'wrong_content']),
  notes: z.string(),
  projects: z
    .array(
      z.object({
        name: z.string().min(1),
        summary: z.string(),
        project_type: z.string(),
        stage: z.string(),
        address: z.string(),
        jurisdiction: z.string(),
        owner_org: z.string(),
        estimated_value: z.string(),
        timeline_note: z.string(),
        evidence_url: z.string(),
        evidence_quote: z.string(),
        work_type_key: z.string(),
        relevance: z.number().int().min(0).max(100),
        confidence: z.number().int().min(0).max(100),
      }),
    )
    .max(40),
});
export type ScanResult = z.infer<typeof scanValidator>;

/* ------------------------------------------------------------------ */
/* Duplicate matching                                                  */
/* ------------------------------------------------------------------ */

export const matchSchema = strictObject({
  matches: {
    type: 'array',
    description: 'One entry per candidate, in the same order as given.',
    items: strictObject({
      candidate_index: int('Zero-based index of the candidate being judged.'),
      existing_project_id: str('The id of the existing project it duplicates, or "" if it is new.'),
      reasoning: str('One sentence on why it matches or is new.'),
    }),
  },
});

export const matchValidator = z.object({
  matches: z.array(
    z.object({
      candidate_index: z.number().int().min(0),
      existing_project_id: z.string(),
      reasoning: z.string(),
    }),
  ),
});
export type MatchResult = z.infer<typeof matchValidator>;

/* ------------------------------------------------------------------ */
/* Project research                                                    */
/* ------------------------------------------------------------------ */

export const researchSchema = strictObject({
  summary_update: str('An improved one-paragraph summary of the project, or "" to keep the existing one.'),
  stage: str('Current stage if you can determine it, else "".'),
  estimated_value: str('Budget/value if found, else "".'),
  timeline_note: str('Best current schedule statement if found, else "".'),
  owner_org: str('Owning or issuing organization if found, else "".'),
  address: str('Street address or location if found, else "".'),
  facts: {
    type: 'array',
    description: 'Discrete findings. Empty array if nothing new.',
    items: strictObject({
      category: enumOf([...FACT_CATEGORIES], 'What kind of fact this is.'),
      label: str('Short label, e.g. "Bid opening", "General contractor", "Owner project manager".'),
      value: str('The fact itself, e.g. "March 14, 2026", "Acme Construction", "Jane Roe".'),
      detail: str('Supporting context, e.g. a role, phone, email, or caveat. Empty if none.'),
      source_url: str('URL that supports this fact.'),
      confidence: int('0-100 confidence in this fact.'),
    }),
  },
  documents: {
    type: 'array',
    description: 'Pages or documents about this project worth archiving. Empty if none.',
    items: strictObject({
      url: str('URL of the document.'),
      title: str('Title of the document.'),
      excerpt: str('The most relevant 1-3 sentences from it.'),
    }),
  },
  no_new_information: {
    type: 'boolean',
    description: 'True if this pass found nothing beyond what was already known.',
  },
});

export const researchValidator = z.object({
  summary_update: z.string(),
  stage: z.string(),
  estimated_value: z.string(),
  timeline_note: z.string(),
  owner_org: z.string(),
  address: z.string(),
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        label: z.string().min(1),
        value: z.string().min(1),
        detail: z.string(),
        source_url: z.string(),
        confidence: z.number().int().min(0).max(100),
      }),
    )
    .max(60),
  documents: z
    .array(z.object({ url: z.string(), title: z.string(), excerpt: z.string() }))
    .max(30),
  no_new_information: z.boolean(),
});
export type ResearchResult = z.infer<typeof researchValidator>;
