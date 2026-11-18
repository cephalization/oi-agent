import { type EndedSpan, readMetadata, stringAttr } from "../format.ts"

const LOCAL_TRACE_ID = "oi_agent.local_trace_id"

/** Project independently of export order: model/decision children can end before their parent. */
export const phoenixTurnSpan = (span: EndedSpan): EndedSpan => {
  const owner = readMetadata(span).turn_owner

  if (owner === undefined || owner.trace_id === span.context.trace_id) return span

  return {
    ...span,
    context: { ...span.context, trace_id: owner.trace_id },
    parent_id: span.parent_id ?? owner.span_id,
    attributes: { ...span.attributes, [LOCAL_TRACE_ID]: span.context.trace_id },
  }
}

/** Phoenix's tree is for display; restore the original trace layout before writing to disk. */
export const localTurnSpan = (span: EndedSpan): EndedSpan => {
  const traceId = stringAttr(span, LOCAL_TRACE_ID)
  const owner = readMetadata(span).turn_owner

  if (traceId === undefined || !/^[a-f0-9]{32}$/.test(traceId) || owner?.trace_id !== span.context.trace_id)
    return span

  const attributes = { ...span.attributes }

  delete attributes[LOCAL_TRACE_ID]

  return {
    ...span,
    context: { ...span.context, trace_id: traceId },
    parent_id: span.parent_id === owner.span_id ? null : span.parent_id,
    attributes,
  }
}
