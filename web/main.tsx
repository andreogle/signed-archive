import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AboutPage } from './pages/About.tsx';
import { ConflictsPage } from './pages/Conflicts.tsx';
import { FeedPage } from './pages/Feed.tsx';
import { FeedsPage } from './pages/Feeds.tsx';
import { Layout, NotFound } from './pages/Layout.tsx';
import { parseConflictsSearch, parseFeedSearch } from './search.ts';

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFound });
const feedsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: FeedsPage });
const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/feed',
  component: FeedPage,
  validateSearch: parseFeedSearch,
});
const conflictsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conflicts',
  component: ConflictsPage,
  validateSearch: parseConflictsSearch,
});
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: '/about', component: AboutPage });
const routeTree = rootRoute.addChildren([feedsRoute, feedRoute, conflictsRoute, aboutRoute]);
const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
