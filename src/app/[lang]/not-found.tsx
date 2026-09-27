import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container narrow page center">
      <h1>404</h1>
      <p className="lead">Страница не найдена · Page not found</p>
      <div className="row center-row">
        <Link href="/ru" className="btn btn-ghost btn-sm">
          На главную
        </Link>
        <Link href="/en" className="btn btn-ghost btn-sm">
          Home
        </Link>
      </div>
    </div>
  );
}
