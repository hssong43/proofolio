import * as z from 'zod';

export const Text = z.string().trim().min(1).max(1200);
export const PageNumber = z.number().int().min(1);
const RegionKey = z.string().regex(/^r[1-9][0-9]*$/);
export const Track = z.enum(['design', 'marketing']);
export type Track = z.infer<typeof Track>;
export const Page = z.strictObject({page: PageNumber, role: z.enum(['project', 'cover', 'profile', 'other']),
  readability: z.enum(['readable', 'partial', 'unreadable']), note: Text});
export const Project = z.strictObject({key: z.string().regex(/^[a-z0-9_-]{1,32}$/), title: Text,
  pages: z.array(PageNumber).min(1).max(60)});
export type Project = z.infer<typeof Project>;
export const FocusTarget = z.strictObject({project_key: Text, anchor_page: PageNumber,
  focus: z.enum(['contribution', 'decision', 'process', 'measurement', 'artifact']),
  specificity: z.enum(['concrete_action', 'artifact_only', 'generic_summary']),
  context_status: z.enum(['located', 'unresolved']), reason: Text,
  importance: z.enum(['core','supporting','minor']).optional(),
  topic: Text.optional(),
  required_context_pages: z.array(PageNumber).max(59), optional_context_pages: z.array(PageNumber).max(2)});
export type FocusTarget = z.infer<typeof FocusTarget>;
export const DocumentMap = z.strictObject({pages: z.array(Page).min(1).max(60),
  projects: z.array(Project).max(60), focus_targets: z.array(FocusTarget).max(12)});
export type DocumentMap = z.infer<typeof DocumentMap>;
export const PageIndex = z.strictObject({pages:z.array(Page.extend({
  project_title:Text.nullable(), heading:Text.nullable(), key_content:Text,
  continues_previous:z.boolean(), referenced_pages:z.array(PageNumber).max(8),
})).min(1).max(12)});
export const Box = z.array(z.number().int().min(0).max(1000)).length(4)
  .refine(([t,l,b,r]) => t < b && l < r, 'Region bounds must have positive width and height.');
export type Box = z.infer<typeof Box>;
export const Region = z.strictObject({key: RegionKey,
  kind: z.enum(['ui_screen','wireframe','user_flow','diagram','brand_asset','editorial_layout','ad_creative',
    'chart','table','analytics_capture','research_artifact','photograph','text_block','other']),
  box: Box, description: Text, salient_text: Text.nullable(), identification: z.enum(['clear','uncertain']),
  readability: z.enum(['readable','partial','unreadable']),
  source_role: z.enum(['candidate_work','reference','template','data_capture','unknown']), role_basis: Text.nullable()})
  .refine(r => (r.source_role !== 'unknown') === (r.role_basis !== null),
    'A source role needs explicit document evidence, otherwise use unknown.');
export type Region = z.infer<typeof Region>;
const RegionLink = z.strictObject({from_key: RegionKey, to_key: RegionKey,
  relation: z.enum(['caption_for','explicit_sequence','explicit_before_after','alternative','detail_of','uncertain']), basis: Text});
export const VisualInventory = z.strictObject({coverage: z.enum(['complete','partial']),
  limitations: z.array(Text).max(40), regions: z.array(Region).max(160), links: z.array(RegionLink).max(160)})
  .refine(v => new Set(v.regions.map(r => r.key)).size === v.regions.length, 'Region keys must be unique.')
  .refine(v => v.links.every(l => l.from_key !== l.to_key &&
    [l.from_key,l.to_key].every(k => v.regions.some(r => r.key === k))), 'Links must reference existing distinct regions.');
export type VisualInventory = z.infer<typeof VisualInventory>;
export const Anchor = z.strictObject({page: PageNumber, region_key: RegionKey, location: Text,
  kind: z.enum(['text','visual']), purpose: z.enum(['claim','artifact','context']),
  quote: Text.nullable(), visual_description: Text.nullable()})
  .refine(a => a.kind === 'text' ? a.quote !== null && a.visual_description === null
    : a.quote === null && a.visual_description !== null, 'Text anchors require quote only; visual anchors require description only.');
export type Anchor = z.infer<typeof Anchor>;
export const Detail = z.strictObject({field: Text, value: Text.nullable(), anchor_indices: z.array(PageNumber).max(6)})
  .refine(d => (d.value !== null) === (d.anchor_indices.length > 0), 'Stated details need source indices; unknown details have none.')
  .refine(d => new Set(d.anchor_indices).size === d.anchor_indices.length, 'Duplicate source indices.');
const BaseEvidence = z.strictObject({focus_target_id: Text.nullable(), statement: Text,
  basis: z.enum(['portfolio_claim','visual_observation']), anchors: z.array(Anchor).min(1).max(6),
  details: z.array(Detail).min(1).max(8)});

export const DESIGN_FIELDS = {
  problem: ['situation','affected_user','problem_signal','success_criterion'],
  audience: ['segment','need','selection_basis','excluded_scope'],
  research: ['method','participants','finding','decision_link'],
  decision: ['chosen_option','stated_rationale','alternative','tradeoff'],
  alternative: ['options','comparison_criterion','selected_option','rejection_reason'],
  constraint: ['constraint','origin','affected_decision','compromise'],
  iteration: ['before','after','trigger','changed_by_candidate'],
  validation: ['method','sample_and_period','result','limitation'],
  contribution: ['own_scope','team_scope','decision_authority','deliverables'],
  artifact: ['artifact_type','visible_structure','stated_stage','stated_usage'],
} as const;
export const MARKETING_FIELDS = {
  objective: ['business_context','goal','success_metric','deadline'],
  audience: ['segment','customer_stage','selection_basis','exclusion'],
  insight: ['source','observed_pattern','interpretation','strategy_link'],
  strategy: ['hypothesis','chosen_approach','alternative','tradeoff'],
  channel: ['channel_and_placement','selection_reason','budget_and_period','allocation_change'],
  creative: ['message','format','target_and_cta','creative_rationale'],
  execution: ['action','schedule','operating_change','candidate_action'],
  experiment: ['hypothesis','variants','comparison_conditions','decision_from_result'],
  metric: ['measurement_definition','audience_and_channel','spend_and_cost_scope','comparison_conditions'],
  contribution: ['own_scope','team_or_agency_scope','decision_authority','attributed_result'],
} as const;
export const Metric = z.strictObject({name: Text, reported_value: Text,
  result_type: z.enum(['reported_actual','target','simulation','unclear']), baseline: Text.nullable(),
  period: Text.nullable(), denominator: Text.nullable(), data_source: Text.nullable(), attribution_method: Text.nullable()});
export const normalize = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
function detailsMatch(e: z.infer<typeof BaseEvidence>, names: readonly string[]) {
  return e.details.length === names.length && new Set(e.details.map(d => d.field)).size === names.length
    && e.details.every(d => names.includes(d.field) && d.anchor_indices.every(i => i <= e.anchors.length));
}
export const DesignEvidence = BaseEvidence.extend({category: z.enum(Object.keys(DESIGN_FIELDS) as [keyof typeof DESIGN_FIELDS, ...Array<keyof typeof DESIGN_FIELDS>])})
  .refine(e => detailsMatch(e, DESIGN_FIELDS[e.category]), 'Detail fields must exactly match category and existing anchors.')
  .refine(e => !['research','validation','contribution'].includes(e.category) || e.basis === 'portfolio_claim',
    'Research, validation and contribution remain portfolio claims.')
  .refine(e => e.category !== 'artifact' || e.details.every(d => !['stated_stage','stated_usage'].includes(d.field)
    || d.value === null || d.anchor_indices.some(i => e.anchors[i-1]?.quote &&
      normalize(e.anchors[i-1].quote!).includes(normalize(d.value!)))), 'Stated artifact stage/usage must quote explicit text.');
export const MarketingEvidence = BaseEvidence.extend({category: z.enum(Object.keys(MARKETING_FIELDS) as [keyof typeof MARKETING_FIELDS, ...Array<keyof typeof MARKETING_FIELDS>]), metric: Metric.nullable()})
  .refine(e => detailsMatch(e, MARKETING_FIELDS[e.category]), 'Detail fields must exactly match category and existing anchors.')
  .refine(e => (e.category === 'metric') === (e.metric !== null), 'Only metric evidence requires a metric object.')
  .refine(e => !['metric','experiment','contribution'].includes(e.category) || e.basis === 'portfolio_claim',
    'Metrics, experiments and contribution remain portfolio claims.');
export const DesignExtraction = z.strictObject({evidence: z.array(DesignEvidence).max(16)});
export const MarketingExtraction = z.strictObject({evidence: z.array(MarketingEvidence).max(16)});
export type Evidence = z.infer<typeof DesignEvidence> | z.infer<typeof MarketingEvidence>;
export const SupportAssessment = z.strictObject({status: z.enum(['documented','needs_explanation','conflicting','not_assessed']),
  reason: Text, anchor_indices: z.array(PageNumber).max(6)});
export const Review = z.strictObject({evidence_id: Text, status: z.enum(['supported','uncertain','unsupported']),
  reason: Text, document_support: SupportAssessment});
export const Reviews = z.strictObject({reviews: z.array(Review).max(16)});
export type Review = z.infer<typeof Review>;
export type ResolvedAnchor = Anchor & {region_id: string; box: Box; source_role: Region['source_role']};
export type ResolvedEvidence = Omit<Evidence,'anchors'> & {
  id: string; project_key: string; anchors: ResolvedAnchor[]; source_check: {status: Review['status']; reason: string; method: string};
  document_support: z.infer<typeof SupportAssessment>; verification_scope: 'presence_in_pdf_only';
  analysis_scope: {reviewed_project_pages: number[]; unreviewed_project_pages: number[]; partial: boolean};
  question_eligible: boolean; question_focus: string | null; unknown_fields: string[]; local_checks: string[];
};
export const InterviewQuestion = z.strictObject({evidence_id: Text, question: Text, intent: Text,
  listen_for: z.array(Text).min(1).max(3)});
export const QuestionSet = z.strictObject({questions: z.array(InterviewQuestion).max(5)});
export const QuestionPlan = z.strictObject({evidence_id:Text,
  anchor_indices:z.array(PageNumber).min(1).max(6),
  angle:z.enum(['problem','decision','process','measurement','ownership']),
  aspect:z.enum(['visual_style','information_hierarchy','flow','message','channel']).optional(),
}).refine(q=>new Set(q.anchor_indices).size===q.anchor_indices.length,'Duplicate question anchors.');
export const QuestionDrafts=z.strictObject({questions:z.array(QuestionPlan.safeExtend({
  question:Text.max(500),intent:Text.max(200),listen_for:z.array(Text.max(200)).min(1).max(3),
})).max(5)});
export type QuestionPlan=z.infer<typeof QuestionPlan>;
export type QuestionDraft=Question & QuestionPlan & {answer_target:string};
export const CoverageSource=z.strictObject({region_id:z.string().regex(/^p[1-9][0-9]*:r[1-9][0-9]*$/),quote:Text.nullable()});
export const FocusCoverage=z.strictObject({focus_target_id:Text,
  checks:z.array(z.strictObject({aspect:Text,source_requirements:z.array(CoverageSource).max(8)
    .refine(rows=>new Set(rows.map(r=>JSON.stringify(r))).size===rows.length,'Duplicate coverage sources.'),question_ids:z.array(Text).max(5)
    .refine(ids=>new Set(ids).size===ids.length,'Duplicate coverage question IDs.')})).min(1).max(8)});
export type FocusCoverage=z.infer<typeof FocusCoverage>;
export const GroundedQuestionReviews=z.strictObject({reviews:z.array(z.strictObject({
  question_id:Text,status:z.enum(['supported','uncertain','unsupported']),reason:Text,
  region_support:z.boolean(),no_added_premise:z.boolean(),distinct_answer:z.boolean(),
  addresses_focus:z.boolean(),substantive:z.boolean(),
})).max(5),focus_coverage:z.array(FocusCoverage).max(72)});
export const QuestionReviews = z.strictObject({reviews: z.array(z.strictObject({question_id: Text,
  status: z.enum(['supported','uncertain','unsupported']), reason: Text})).max(5)});
export type Question = z.infer<typeof InterviewQuestion>;
export type QuestionCard = Question & {id: string; project_key: string; anchors: ResolvedAnchor[];
  focus_target_id: string | null; document_support: z.infer<typeof SupportAssessment>;
  angle?:QuestionDraft['angle'];aspect?:QuestionPlan['aspect'];answer_target?:string;
  focus_check?:{matches:boolean;method:string;reason:string};
  source_excerpt?:Array<{region_id:string;quote:string|null;observation:string|null}>};

// Gemini gets a compatible shape; refinements remain strict local trust-boundary checks.
export function responseSchema(schema: z.ZodType,closedObjects=false): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {io: 'input'});
  function shape(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shape);
    if (!value || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if ('$ref' in obj) throw new Error('Recursive/reference schemas are not supported.');
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (key === 'properties') result[key] = Object.fromEntries(Object.entries(item as object).map(([k,v]) => [k,shape(v)]));
      else if (['type','required','items','enum','anyOf'].includes(key)) result[key] = shape(item);
      else if (key === 'const') result.enum = [item];
    }
    if(closedObjects&&obj.type==='object')result.additionalProperties=false;
    return result;
  }
  return shape(json) as Record<string, unknown>;
}
