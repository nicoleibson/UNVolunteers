# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 2.0.x | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Lifeline Core, please report it responsibly:

### How to Report
- **Email:** Open a private security advisory on GitHub or contact the repository maintainer
- **GitHub:** Use [GitHub Security Advisories](https://github.com/nicoleibson/UNVolunteers/security/advisories/new)
- **Do not** create a public GitHub issue for security vulnerabilities

### What to Include
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

### Response Timeline
- We will acknowledge receipt within 48 hours
- We will provide an assessment and timeline within 7 days
- We will keep you informed throughout the process
- We will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Considerations

### Encryption
- Mesh communications use AES-128-CTR encryption
- Default demo key is clearly marked as `SOLO DEMO` and must not be used in production
- Production deployments must use unique keys distributed out-of-band

### Best Practices for Deployment
- Generate unique AES keys: `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
- Never commit keys or credentials to the repository
- Use environment variables for sensitive configuration (`.env` files are gitignored)
- Keep software updated
- Restrict network access to trusted devices in disaster scenarios
- Review firewall rules when deploying gateways

### Known Security Notes
- WebRTC signaling uses manual copy/paste (by design for offline/disconnected scenarios)
- No cloud services or external dependencies
- All cryptographic operations use Node.js built-in crypto module
- No telemetry or data collection

## Acknowledgments

We appreciate the security research community's help in keeping Lifeline Core safe for humanitarian use.
