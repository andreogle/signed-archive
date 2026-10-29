import { Link, Outlet } from '@tanstack/react-router';

export function Layout() {
  return (
    <>
      <header className="top">
        <Link className="brand" to="/">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 18 10 6l4 8 2-4 4 8" />
          </svg>
          signed-archive
        </Link>
        <nav className="nav" aria-label="Main">
          <Link to="/" activeOptions={{ exact: true }}>
            Feeds
          </Link>
          <Link to="/feed" search={{ feed: 'ETH/USD', range: '24h', endpoint: 'public' }}>
            Explorer
          </Link>
          <Link to="/conflicts" search={{ range: '24h' }}>
            Conflicts
          </Link>
          <Link to="/about">About</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="foot small">
        Independent project, not affiliated with API3. Data from{' '}
        <a href="https://signed-api.api3.org">signed-api.api3.org</a>; feed names from API3's provider list.
      </footer>
    </>
  );
}

export function NotFound() {
  return (
    <section className="intro">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to all feeds</Link>
      </p>
    </section>
  );
}
