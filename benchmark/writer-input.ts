// Read-only writer-input comparison. No provider calls or legacy replay entrypoint.
import type {ModelRequest} from '../src/llm.ts';
import {sha256} from '../src/pipeline.ts';
import {responseSchema} from '../src/schema.ts';
import {SYSTEM} from '../src/prompts.ts';

export function writerInput(request:ModelRequest,evidenceOnly:boolean){
  if(request.kind!=='QuestionSet'||request.pdf||request.pdf_uri||(evidenceOnly&&request.images?.length))throw new Error('Invalid comparison input boundary.');
  const input={system:SYSTEM,prompt:request.prompt,response_schema:responseSchema(request.schema),evidence_only:evidenceOnly,
    thinking_level:request.thinkingLevel??null,max_output_tokens:request.maxOutputTokens??16384,
    images:(request.images??[]).map(([label,png])=>({label,sha256:sha256(png)}))};
  return {...input,sha256:sha256(JSON.stringify(input))};
}
export function assertSameInput(actual:ReturnType<typeof writerInput>,expected:ReturnType<typeof writerInput>){
  const {sha256:digest,...input}=expected;
  const {sha256:actualDigest,...actualInput}=actual;
  if(digest!==sha256(JSON.stringify(input))||actualDigest!==sha256(JSON.stringify(actualInput))||actualDigest!==digest)throw new Error('First writer input differs from the frozen comparison input.');
}
