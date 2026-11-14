// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sjlDocs from '@superjackfruit/docs-theme';

export default defineConfig({
  site: 'https://docs.superexchange.dev',
  integrations: [
    starlight({
      title: 'SuperExchange',
      description:
        "The suite's communication server: a Matrix application service that carries SuperPipeline's board work into the board's chat room, and a person's answer back to the board.",
      // The suite's docs theme: vibekit's azure, the faces, the street, status badges, the footers,
      // the 404, the edit link and llms.txt. See @superjackfruit/docs-theme's README.
      plugins: [
        sjlDocs({
          product: 'superexchange',
          status: 'wet paint',
          // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs.
          llms: {
            description:
              "SuperExchange is the suite's communication server: a Matrix application service that " +
              "carries SuperPipeline's gates, questions, delivery follow-ups and waiting cards into the " +
              "board's end-to-end encrypted chat room, says the board's reminders, escalations and other " +
              'notices there, and carries a person\'s answer back to the board as that person, with one ' +
              "receipt. It takes board events from the suite's event relay, asks the organization plane " +
              '(Accounts) who a Matrix sender is, and speaks under its own appservice registration. It ' +
              "carries treaty's board-room event contract and defines none of it. It is early (v0.0.x), " +
              'a Bun service with a SQLite store, and MIT licensed.',
          },
        }),
      ],
      favicon: '/favicon.svg',
      head: [
        // The link preview, copied from landing/public/og.png so this host serves its own.
        // Absolute URLs: several unfurlers ignore a relative og:image.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.superexchange.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'SuperExchange: board work in chat, and the answer back' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.superexchange.dev/og.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/SuperJackfruitLabs/superexchange' }],
      // The suite's five groups, in the order a reader needs them.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What SuperExchange is', slug: 'what-it-is' },
            { label: 'How it works', slug: 'how-it-works' },
            { label: 'Status and limits', slug: 'status' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Board rooms', slug: 'board-chat/rooms' },
            { label: 'Gates', slug: 'board-chat/gates' },
            { label: 'Questions and approvals', slug: 'board-chat/questions' },
            { label: 'Follow-ups and waiting cards', slug: 'board-chat/follow-ups-and-waiting-cards' },
            { label: 'Notices, pull-backs, overrides', slug: 'board-chat/notices' },
            { label: 'The sweeps', slug: 'board-chat/sweeps' },
            { label: 'Encryption', slug: 'board-chat/encryption' },
            { label: 'Linking a Matrix id', slug: 'operate/linking' },
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'Events carried', slug: 'reference/events' },
            { label: 'HTTP routes', slug: 'reference/routes' },
          ],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Run it', slug: 'operate/run' },
            { label: 'Opt a board in', slug: 'operate/boards' },
            { label: 'Production and backups', slug: 'operate/production' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Settings', slug: 'operate/settings' },
            { label: 'What it calls', slug: 'reference/calls' },
          ],
        },
      ],
    }),
  ],
});
