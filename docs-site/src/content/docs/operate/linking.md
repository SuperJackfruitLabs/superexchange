---
title: Linking a Matrix id
description: Why an answer in chat counts only from a person whose Matrix id is linked at Accounts, how a person links their own, the 15-minute hold, and what SuperExchange says to someone who has not linked.
---

SuperExchange never decides who someone is. For every answer it asks the organization plane
(Accounts) which principal the sender's Matrix id is linked to
(`GET /api/identities/matrix/:mxid`), and what kind of principal that is. Only a linked person's
answer can act at SuperPipeline, and it acts as that person.

## A person links their own

No service can link a Matrix id to a person: Accounts refuses it by design, so a service cannot
make somebody's chat account speak for them. The person does it themselves, with two proofs
presented together:

1. their own Accounts session, freshly confirmed (Accounts asks them to sign in again if it is
   not recent);
2. an OpenID token from their homeserver, which Accounts verifies with that homeserver.

In SuperMessage this is **Settings → Account → Link to your Super Jackfruit account**. The app
gets the OpenID token from the homeserver and opens Accounts' `/link/matrix` page with it; the
person signs in if they need to and confirms. Any Matrix client that can open that page the same
way can link.

Accounts' rules, which SuperExchange relies on:

- **Configured homeservers only.** Accounts lists the homeservers whose users may link
  (`MATRIX_HOMESERVERS`). Unset, self-linking is off.
- **One person per Matrix id.** An id linked to somebody else is refused until its owner unlinks
  it, or an Accounts operator moves it.
- **Single use.** Each OpenID token links once.
- **The person can see and remove the link** in their Accounts security settings.

## The 15-minute hold

A self-made link acts **15 minutes after it was made**. Until then Accounts answers that the
identity is pending, and SuperExchange reads that as "linked to nobody". An answer sent in those 15
minutes does not count; answer again once the hold is over.

## What SuperExchange says to someone not linked

To a **gate** answer from a sender linked to nobody, once per UTC day in that room:

> Your answer didn't count: your Matrix account isn't linked to your Super Jackfruit account yet. To
> approve from chat, link it in SuperMessage: Settings → Account → Link to your Super Jackfruit
> account. A new link starts working 15 minutes after you make it.

Answers to questions, follow-ups and waiting cards from an unlinked sender are ignored without a
word.

When Accounts cannot be reached at all, SuperExchange says so ("the account service is
unreachable. Nothing has changed; try again in a minute.") rather than treating the person as
unlinked.

## Agents

An agent's Matrix id may be linked to an agent principal (AgentPod does that at station setup).
That never lets it answer a gate, an approval request, a follow-up or a waiting card: those need a
`human` principal. An agent's question can be answered by any linked principal.
