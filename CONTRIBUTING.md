# Contributing to Lifeline Core

Thank you for your interest in contributing to Lifeline Core! This project aims to provide resilient communication for disaster response, and every contribution helps save lives.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and collaborative environment focused on humanitarian impact.

## How to Contribute

### Reporting Issues
- Check existing issues before creating a new one
- Provide clear description of the bug or feature request
- Include steps to reproduce for bugs
- Mention your environment (Node.js version, OS, browser)

### Submitting Pull Requests
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests to ensure nothing is broken
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

## Development Guidelines

### Code Style
- Use clear, descriptive variable and function names
- Follow existing code patterns in the project
- Keep functions focused and modular
- Add comments only when necessary for complex logic
- Use Spanish or English consistently within a file

### Testing
- All new features must include tests
- Run the full test suite before submitting: `npm test`
- Tests must pass with zero failures
- Add tests to the appropriate `test/*.test.js` file

### Core Principles
- **Zero Fake Data:** Never invent sensor readings or telemetry data
- **Offline-First:** Ensure functionality works without network connectivity
- **No Dependencies:** Keep the project dependency-free where possible
- **Security:** Never commit secrets, keys, or credentials
- **Simplicity:** Prioritize reliability over complexity in emergency scenarios

## Project Structure

```
radio/          - RF stack (LoRa, APRS, SDR, protocols)
simulation/     - Web PWA and server
test/           - Automated test suite
docs/           - Documentation
```

## Testing Locally

```bash
# Install Node.js >= 18
# Run all tests
npm test

# Run specific test suites
npm run test:radio
npm run test:sim
npm run test:server
npm run test:integration
```

## Questions?

Feel free to open an issue for discussion or clarification. We're here to build technology that saves lives together.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
