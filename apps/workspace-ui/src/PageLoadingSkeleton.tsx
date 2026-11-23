export function PageLoadingSkeleton() {
  return <div className="page-loading-skeleton" role="status" aria-label="页面加载中" aria-busy="true">
    <div className="page-loading-skeleton__heading" aria-hidden="true">
      <span className="page-loading-skeleton__shape page-loading-skeleton__title" />
      <span className="page-loading-skeleton__shape page-loading-skeleton__subtitle" />
    </div>
    <div className="page-loading-skeleton__section" aria-hidden="true">
      <span className="page-loading-skeleton__shape page-loading-skeleton__section-title" />
      <div className="page-loading-skeleton__fields">
        {[0, 1, 2, 3].map(field => <div className="page-loading-skeleton__field" key={field}>
          <span className="page-loading-skeleton__shape page-loading-skeleton__label" />
          <span className="page-loading-skeleton__shape page-loading-skeleton__control" />
        </div>)}
      </div>
    </div>
    <div className="page-loading-skeleton__section page-loading-skeleton__section--compact" aria-hidden="true">
      <span className="page-loading-skeleton__shape page-loading-skeleton__section-title" />
      <span className="page-loading-skeleton__shape page-loading-skeleton__summary" />
      <span className="page-loading-skeleton__shape page-loading-skeleton__action" />
    </div>
  </div>;
}
