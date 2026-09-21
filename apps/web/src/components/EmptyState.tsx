export function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden>
        <span className="material-symbols-outlined">check_circle</span>
      </div>
      <h1 className="empty-state__headline">All quiet. Nothing needed you today.</h1>
      <p className="empty-state__sub">
        Dialy is watching. You&apos;ll see it here when something needs a decision.
      </p>
    </div>
  );
}
