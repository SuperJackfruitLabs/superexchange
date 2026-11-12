/**
 * What a gate offers, as the store records it, and the transaction ids its events are sent
 * under. Pure: posting (`gate-card.ts`), the receipt (`gate-receipt.ts`) and the repost after an
 * escalation (`escalation-repost.ts`) all read these, and none of them imports another for it.
 */
import {
  gateOptionsV2,
  gateSubjectV2,
  gateVariantsV2,
  quorumV2,
  type GatePendingDelivery,
} from "@superjackfruitlabs/treaty-matrix-events";
import type { GateOffer } from "../store/index.ts";

/** The transaction id a gate's event is sent under: the same on every try. */
export function gateTxnId(
  gateId: string,
  part: "prose" | "card" | "outcome.prose" | "outcome.card",
): string {
  return `superexchange.gate.${gateId}.${part}`;
}

/**
 * What a gate offers, exactly as its gate.v2 carries it (the hub's `claimGate`): the options, the
 * subject an approval binds to, or the variants it offers a choice of, and its quorum. An answer
 * is checked against this record, never against a list.
 */
export function gateOffer(gate: GatePendingDelivery): GateOffer {
  const subject = gateSubjectV2(gate);
  const variants = gateVariantsV2(gate);
  return {
    options: gateOptionsV2(gate).map((o) => ({
      id: o.id,
      label: o.label,
      meaning: o.meaning,
      needs_comment: o.needs_comment,
    })),
    subjectId: subject?.id ?? null,
    subjectDigest: subject?.digest ?? null,
    subjectPreviewComplete: subject?.preview_complete ?? null,
    variants:
      variants?.map((v) => ({
        id: v.id,
        label: v.label,
        subject_id: v.subject.id,
        digest: v.subject.digest,
        preview_complete: v.subject.preview_complete,
        expires_at: v.subject.expires_at,
      })) ?? null,
    quorum: quorumV2(gate.quorum),
  };
}
