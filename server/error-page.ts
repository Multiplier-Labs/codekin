/**
 * Generates a styled 404 error page matching the Codekin design theme.
 */
export function generate404Page(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>404 — Codekin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inconsolata:wght@400;600&family=Lato:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #090e0f;
      color: #c6d4d5;
      font-family: 'Lato', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
    }
    .code {
      font-family: 'Inconsolata', monospace;
      font-size: 6rem;
      font-weight: 600;
      color: #e4ae42;
      line-height: 1;
      margin-bottom: 0.5rem;
    }
    h1 {
      font-family: 'Lato', sans-serif;
      font-size: 1.5rem;
      font-weight: 700;
      color: #dce4e5;
      margin-bottom: 1rem;
    }
    p {
      color: #94aeb1;
      font-size: 1rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    a {
      display: inline-block;
      padding: 0.65rem 1.75rem;
      background: #e4ae42;
      color: #1e170a;
      font-weight: 700;
      font-size: 0.9rem;
      border-radius: 6px;
      text-decoration: none;
      transition: background 0.15s;
    }
    a:hover { background: #cf9a2d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="code">404</div>
    <h1>Page not found</h1>
    <p>The page you're looking for doesn't exist or the session may have been removed.</p>
    <a href="/">Go to Home</a>
  </div>
</body>
</html>`
}

export function generate500Page(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>Error — Codekin</title>
  <link href="https://fonts.googleapis.com/css2?family=Inconsolata:wght@400;600&family=Lato:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #090e0f;
      color: #c6d4d5;
      font-family: 'Lato', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
    }
    .code {
      font-family: 'Inconsolata', monospace;
      font-size: 6rem;
      font-weight: 600;
      color: #d94444;
      line-height: 1;
      margin-bottom: 0.5rem;
    }
    h1 {
      font-family: 'Lato', sans-serif;
      font-size: 1.5rem;
      font-weight: 700;
      color: #dce4e5;
      margin-bottom: 1rem;
    }
    p {
      color: #94aeb1;
      font-size: 1rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    a {
      display: inline-block;
      padding: 0.65rem 1.75rem;
      background: #e4ae42;
      color: #1e170a;
      font-weight: 700;
      font-size: 0.9rem;
      border-radius: 6px;
      text-decoration: none;
      transition: background 0.15s;
    }
    a:hover { background: #cf9a2d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="code">500</div>
    <h1>Something went wrong</h1>
    <p>An unexpected error occurred. Please try again or return to the home page.</p>
    <a href="/">Go to Home</a>
  </div>
</body>
</html>`
}
