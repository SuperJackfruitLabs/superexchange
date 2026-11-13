// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://docs.superexchange.dev',
  integrations: [
    starlight({
      title: 'SuperExchange',
      description:
        "The suite's communication server: a Matrix application service that carries SuperPipeline's board work into the board's chat room, and a person's answer back to the board.",
      // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs. The
      // full file carries every page, reference pages included; the small one drops asides
      // and <details> but keeps every page too, since nothing here is noise.
      plugins: [
        starlightLlmsTxt({
          projectName: 'SuperExchange',
          description:
            "SuperExchange is the suite's communication server: a Matrix application service that " +
            "carries SuperPipeline's gates, questions, delivery follow-ups and waiting cards into the " +
            "board's end-to-end encrypted chat room, says the board's reminders, escalations and other " +
            'notices there, and carries a person\'s answer back to the board as that person, with one ' +
            "receipt. It takes board events from the suite's event relay, asks the organization plane " +
            '(Accounts) who a Matrix sender is, and speaks under its own appservice registration. It ' +
            "carries treaty's board-room event contract and defines none of it. It is early (v0.0.x), " +
            'a Bun service with a SQLite store, and MIT licensed.',
          optionalLinks: [
            { label: 'SuperExchange', url: 'https://superexchange.dev', description: 'The product site.' },
            { label: 'Source', url: 'https://github.com/SuperJackfruitLabs/superexchange', description: 'The SuperExchange repository on GitHub, mirrored from the forge.' },
          ],
        }),
      ],
      // The mark beside the name, as on the landing page. See the component for why it
      // replaces Starlight's own rather than using the `logo` option.
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      // The landing page's palette and faces; see src/styles/theme.css for each value.
      customCss: ['./src/styles/theme.css'],
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href:
              'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600' +
              '&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
          },
        },
        // The link preview, copied from landing/public/og.png so this host serves its own.
        // Absolute URLs: several unfurlers ignore a relative og:image.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.superexchange.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'SuperExchange: board work in chat, and the answer back' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.superexchange.dev/og.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/SuperJackfruitLabs/superexchange' }],
      // Four sections, in the order a reader needs them: what it is and where it stands, what
      // happens in a board's room, standing it up, then the exact surfaces.
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
          label: 'In the board room',
          items: [
            { label: 'Board rooms', slug: 'board-chat/rooms' },
            { label: 'Gates', slug: 'board-chat/gates' },
            { label: 'Questions and approvals', slug: 'board-chat/questions' },
            { label: 'Follow-ups and waiting cards', slug: 'board-chat/follow-ups-and-waiting-cards' },
            { label: 'Notices, pull-backs, overrides', slug: 'board-chat/notices' },
            { label: 'The sweeps', slug: 'board-chat/sweeps' },
            { label: 'Encryption', slug: 'board-chat/encryption' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'Run it', slug: 'operate/run' },
            { label: 'Settings', slug: 'operate/settings' },
            { label: 'Opt a board in', slug: 'operate/boards' },
            { label: 'Linking a Matrix id', slug: 'operate/linking' },
            { label: 'Production and backups', slug: 'operate/production' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'HTTP routes', slug: 'reference/routes' },
            { label: 'Events carried', slug: 'reference/events' },
            { label: 'What it calls', slug: 'reference/calls' },
          ],
        },
      ],
    }),
  ],
});
