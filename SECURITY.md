# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | Yes                |

## Reporting a Vulnerability

If you discover a security vulnerability in Engram, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email **claudettetheai@gmail.com** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if you have one)

You will receive acknowledgment within 48 hours and a detailed response within 7 days.

## Security Considerations

Engram stores conversation history and extracted knowledge in PostgreSQL. Keep in mind:

- **Database access** controls who can read your memories. Secure your `DATABASE_URL`.
- **API keys** (Anthropic, if used) should never be committed. Use `.env` files.
- **Embeddings** are generated locally by default — no data leaves your machine for search.
- **Artifact extraction** can use Claude API or local LLMs. If using Claude API, conversation content is sent to Anthropic's servers per their [privacy policy](https://www.anthropic.com/privacy).

## Best Practices

- Use a dedicated PostgreSQL user with limited privileges for Engram
- Keep your `.env` file out of version control (already in `.gitignore`)
- Regularly update dependencies (`npm audit`)
- Back up your database (`pg_dump`)
