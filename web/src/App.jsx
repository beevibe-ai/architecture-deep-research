import { Link, Route, Routes, useLocation } from "react-router-dom";
import RunsIndex from "./views/RunsIndex.jsx";
import RunDetail from "./views/RunDetail.jsx";
import NewRunForm from "./views/NewRunForm.jsx";

export default function App() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-ink-800 bg-ink-950/80 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-baseline gap-3">
            <Link to="/" className="text-base font-semibold tracking-tight text-ink-100">
              Architecture Deep Research
            </Link>
            <span className="text-xs uppercase tracking-widest text-ink-500">
              Observability + product
            </span>
          </div>
          <nav aria-label="Primary" className="flex items-center gap-4 text-sm">
            <Link
              to="/"
              aria-current={pathname === "/" ? "page" : undefined}
              className={
                pathname === "/"
                  ? "text-ink-100 underline decoration-accent-500 underline-offset-4"
                  : "text-ink-300 hover:text-ink-100"
              }
            >
              Runs
            </Link>
            <Link
              to="/new"
              aria-current={pathname === "/new" ? "page" : undefined}
              className={
                pathname === "/new"
                  ? "rounded-md bg-accent-500 px-3 py-1.5 text-ink-950 font-medium"
                  : "rounded-md border border-accent-500/40 px-3 py-1.5 text-accent-400 hover:bg-accent-500/10"
              }
            >
              + New run
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <Routes>
            <Route path="/" element={<RunsIndex />} />
            <Route path="/new" element={<NewRunForm />} />
            <Route path="/runs/:id" element={<RunDetail />} />
          </Routes>
        </div>
      </main>
      <footer className="border-t border-ink-800 px-6 py-3 text-xs text-ink-500">
        Boundary: ADR stops at Execution Handoff. Downstream coding agents consume the artifacts.
      </footer>
    </div>
  );
}
