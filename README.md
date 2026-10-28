# Lifeline Core by Zentec

**[English](#english) | [Español](#español)**

---

<a name="english"></a>

## English

### Resilient, offline-first communication that saves lives when everything else fails.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >=18](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-blue.svg)](https://web.dev/progressive-web-apps/)
[![Tests](https://img.shields.io/badge/Tests-277%2B%20passing-brightgreen.svg)](#project-status)
[![Open Source](https://img.shields.io/badge/Open%20Source-MIT-orange.svg)](LICENSE)

## The Problem

When natural disasters strike, cellular networks collapse, internet connectivity is lost, and traditional communication channels become unavailable. For first responders and communities in disaster zones, this communication blackout can be the difference between life and death.

## The Solution

**Lifeline Core** is an autonomous, offline-first communication platform built by **Zentec** (early-stage startup). It creates a resilient communication grid that works without internet, cellular coverage, or centralized infrastructure. Designed to run on **Android devices** (browsers or Termux) and low-cost edge hardware, it enables life-saving coordination when all else fails.

## Key Features

- **LoRa Mesh Network** - Long-range, low-power mesh communication between devices (433/868/915 MHz)
- **Autonomous Gateway** - Raspberry Pi/Orange Pi can act as a self-sufficient communication hub with Wi-Fi AP
- **Offline-First PWA** - Installable web app that works completely offline, optimized for Android devices
- **Multi-Transport Resilience** - LoRa, Wi-Fi Direct, WebRTC, APRS/AX.25, and SDR integration
- **Decentralized Architecture** - No central server required. Each device can operate independently
- **Real Sensor Integration** - GPS, barometer, accelerometer, battery, and BLE biometric sensors from Android devices
- **Store-and-Forward (DTN)** - Data mule capabilities for delayed delivery in fragmented networks
- **Early Warning System** - P-Wave detection and alert propagation across the mesh
- **Emergency Voice & Radio** - WebRTC voice channels and AM/FM emergency broadcast reception
- **Open Source** - MIT licensed for maximum accessibility and adoption

## Demo

See [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) for guidance on demonstrating the platform capabilities.

## Architecture

Lifeline Core uses a layered architecture designed for disaster resilience:

```
[USERS] Android Smartphones/Tablets (PWA)
           ↓
[EDGE] Autonomous Gateway (Wi-Fi AP + Lifeline Server)
           ↓
[MESH] LoRa Mesh / Wi-Fi Direct / WebRTC
           ↓
[RF CLASSIC] APRS/VHF-UHF + SDR Reception
           ↓
[EXTENSION] Satellite/HF (Future)
```

For a detailed breakdown, see [docs/ARCHITECTURE_SIMPLIFIED.md](docs/ARCHITECTURE_SIMPLIFIED.md).

## Quick Start

### Prerequisites
- Node.js >= 18
- Any modern browser (Chrome, Chromium recommended for full features)

### Run Locally

```bash
# Clone the repository
git clone https://github.com/nicoleibson/UNVolunteers.git
cd UNVolunteers

# Start the gateway/server
cd simulation/simulation
node server.js
```

Open your browser to `http://localhost:8000/index_integrated.html`

### Run Tests

```bash
npm test
```

All tests pass (277+ tests across the full suite).

## Project Status

- **Fully functional prototype** with complete RF stack implementation
- **277+ automated tests passing** with zero failures
- **Validated in collaboration** with PNUD Argentina
- **PWA installable** with offline capabilities
- **Gateway deployment documented** for Raspberry Pi/Orange Pi
- **MIT Licensed** - Free for humanitarian use
- **Android-first design** - Works on the most accessible devices in vulnerable regions

## Author

**Developed and maintained by a solo developer under [Zentec](https://github.com/nicoleibson), an early-stage initiative focused on resilient communication for disaster response.**

## License

This project is licensed under the [MIT License](LICENSE).

---

<a name="español"></a>

## Español

### Comunicación resiliente y offline-first para salvar vidas cuando todo lo demás falla.

## El Problema

Cuando ocurren desastres naturales, las redes celulares colapsan, la conectividad a internet se pierde y los canales de comunicación tradicionales dejan de funcionar. Para los equipos de respuesta y las comunidades afectadas, este apagón de comunicaciones puede marcar la diferencia entre la vida y la muerte.

## La Solución

**Lifeline Core** es una plataforma de comunicaciones autónoma y offline-first desarrollada por **Zentec** (startup en etapa inicial). Crea una red de comunicación resiliente que funciona sin internet, sin cobertura celular y sin infraestructura centralizada. Diseñada para funcionar en **dispositivos Android** (navegador o Termux) y hardware de borde de bajo costo, permite la coordinación vital cuando todo lo demás falla.

## Características Clave

- **Malla LoRa** - Comunicación de largo alcance y bajo consumo entre dispositivos (433/868/915 MHz)
- **Gateway Autónomo** - Raspberry Pi/Orange Pi puede funcionar como hub de comunicaciones autosuficiente con punto Wi-Fi
- **PWA Offline-First** - Aplicación web instalable que funciona completamente sin conexión, optimizada para Android
- **Múltiples Transportes** - LoRa, Wi-Fi Direct, WebRTC, APRS/AX.25 e integración SDR
- **Arquitectura Descentralizada** - Sin servidor central. Cada dispositivo puede operar de forma independiente
- **Sensores Reales** - Integración con GPS, barómetro, acelerómetro, batería y sensores biométricos BLE de Android
- **Store-and-Forward (DTN)** - Capacidad de retransmisión diferida para redes fragmentadas
- **Sistema de Alerta Temprana** - Detección de onda P y propagación de alertas en la malla
- **Voz de Emergencia y Radio** - Canales de voz WebRTC y recepción de emisiones de emergencia AM/FM
- **Código Abierto** - Licencia MIT para máxima accesibilidad y adopción

## Inicio Rápido

```bash
# Clonar el repositorio
git clone https://github.com/nicoleibson/UNVolunteers.git
cd UNVolunteers

# Iniciar el servidor/gateway
cd simulation/simulation
node server.js
```

Abrir `http://localhost:8000/index_integrated.html` en el navegador.

## Estado del Proyecto

- **Prototipo funcional completo** con stack RF implementado
- **277+ pruebas automatizadas** sin fallos
- **Validado** en colaboración con PNUD Argentina
- **PWA instalable** con capacidades offline
- **Gateway documentado** para Raspberry Pi/Orange Pi
- **Licencia MIT** - Libre para uso humanitario
- **Diseño Android-first** - Funciona en los dispositivos más accesibles en regiones vulnerables

## Autor

**Desarrollado y mantenido por un desarrollador único bajo [Zentec](https://github.com/nicoleibson), una iniciativa en etapa inicial enfocada en comunicaciones resilientes para respuesta a desastres.**

## Licencia

Este proyecto está bajo la [Licencia MIT](LICENSE).
