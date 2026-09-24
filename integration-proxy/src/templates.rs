/// Minimal, dependency-free HTML rendering. The proxy has no accounts and
/// no login (issue #54): the only pages are the landing page and the
/// per-platform consent screen.
pub fn render_home() -> String {
    include_str!("../static/index.html").to_owned()
}

/// Renders the consent screen for one selected platform. `destination` is
/// where the browser returns to (an origin, or the app's deep link).
pub fn render_platform_connect(
    platform: &str,
    destination: &str,
    csrf: &str,
    requires_api_key: bool,
) -> String {
    let (api_key_field, button_label) = if requires_api_key {
        (
            r#"<p class="secret-help">Find this in your account settings on the platform's own site. It is stored encrypted on this proxy and never sent back to the destination.</p>
               <input class="button" style="background:white;color:#202124;border:1px solid #ccc" type="password" name="api_key" autocomplete="off" placeholder="API key" required />"#,
            format!("Connect {}", escape(&platform_label(platform))),
        )
    } else {
        (
            "",
            format!(
                "Use LocalThought to sync {} with this destination",
                escape(&platform_label(platform))
            ),
        )
    };
    let body = format!(
        r#"
        <div class="card">
          <h1>Connect {platform}</h1>
          <p>Destination: <span class="email">{destination}</span></p>
          <p class="secret-help">The destination finishes connecting by signing with your Atomic key; it becomes the connection's owner.</p>
          <form method="post" action="/connect/authorize">
            <input type="hidden" name="csrf" value="{csrf}" />
            {api_key_field}
            <button class="button" type="submit">{button_label}</button>
          </form>
        </div>
        "#,
        platform = escape(&platform_label(platform)),
        destination = escape(destination),
        csrf = escape(csrf),
    );
    page(&body)
}

fn platform_label(platform: &str) -> String {
    platform
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn page(body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LocalThought · Integrations</title>
  <link rel="icon" type="image/png" href="/logo.png" />
  <style>
    :root {{ color-scheme: light dark; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      margin: 0;
      background: #f5f5f7;
    }}
    .card {{
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
      padding: 2.5rem;
      text-align: center;
      max-width: 24rem;
    }}
    .avatar {{
      width: 4rem;
      height: 4rem;
      border-radius: 50%;
      margin-bottom: 1rem;
    }}
    .email {{ color: #666; margin-top: -0.5rem; }}
    .secret-help {{ color: #666; font-size: 0.85rem; }}
    .button {{
      display: inline-block;
      margin-top: 1rem;
      padding: 0.6rem 1.4rem;
      background: #1a73e8;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      font-size: 1rem;
    }}
    .button-secondary {{ background: #5f6368; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #202124; }}
      .card {{ background: #303134; color: #e8eaed; }}
      .email {{ color: #9aa0a6; }}
      .secret-help {{ color: #9aa0a6; }}
    }}
  </style>
</head>
<body>
  <main>
    <a href="/" aria-label="LocalThought home" style="display:block;text-align:center;margin-bottom:1rem"><img src="/logo.png" alt="LocalThought" width="80" height="80" style="border-radius:8px" /></a>
    {body}
  </main>
</body>
</html>"#,
        body = body
    )
}

fn escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_has_no_login() {
        let html = render_home();
        assert!(!html.contains("/auth/login"));
        assert!(!html.contains("{{"));
    }

    #[test]
    fn platform_connect_shows_one_selected_platform_and_escapes_fields() {
        let html = render_platform_connect(
            "google-calendar",
            "https://hub.example/\"><script>alert(1)</script>",
            "csrf&<\"",
            false,
        );
        assert!(html.contains("Google Calendar"));
        assert!(html.contains("Use LocalThought to sync Google Calendar with this destination"));
        assert_eq!(html.matches(r#"action="/connect/authorize""#).count(), 1);
        assert!(html.contains("name=\"csrf\" value=\"csrf&amp;&lt;&quot;\""));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("api_key"));
        assert!(!html.to_lowercase().contains("log in"));
    }

    #[test]
    fn api_key_platforms_ask_for_the_key_on_the_proxy_page() {
        let html = render_platform_connect("clockify", "https://hub.example", "csrf", true);
        assert!(html.contains(r#"name="api_key""#));
        assert!(html.contains("Connect Clockify"));
    }
}
