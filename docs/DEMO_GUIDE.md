# Demo Guide - Lifeline Core

## Overview

This guide helps you demonstrate the key capabilities of Lifeline Core. You already have a demo video - use this guide to structure your presentation and highlight the most impactful features for different audiences.

## Target Audiences

| Audience | Focus Points | Time |
| --- | --- | --- |
| **Google.org Reviewers** | Impact, accessibility, offline capability, scalability | 2-3 minutes |
| **Technical Evaluators** | Architecture, mesh networking, PWA, tests | 3-4 minutes |
| **Humanitarian Partners** | Real-world use case, ease of deployment, cost-effectiveness | 2-3 minutes |

## Key Demonstration Flow

### 1. The Problem (15-20 seconds)
- **Show context:** Explain communication blackout during disasters
- **Emphasize impact:** Highlight how lack of communication affects rescue operations
- **Set stakes:** "When everything else fails, communication can save lives"

### 2. The Solution Overview (20-30 seconds)
- **Show the interface:** Open the PWA on an Android device
- **Highlight offline-first:** Demonstrate it works without internet/cellular
- **Show decentralization:** No server setup required, peer-to-peer

### 3. Core Features Demo (60-90 seconds)

| Feature | What to Show | Impact |
| --- | --- | --- |
| **PWA Installation** | Install to home screen on Android | Shows accessibility and app-like experience |
| **Offline Operation** | Turn on airplane mode, navigate the app | Proves it works without connectivity |
| **Autonomous Gateway** | Show `node server.js` creating a local network | Demonstrates low-cost deployment |
| **Mesh Discovery** | Connect multiple devices, show automatic peer discovery | Shows decentralized coordination |
| **Role Classification** | Trigger P-WAVE, show automatic role assignment | Demonstrates intelligent alert system |
| **Real-time Status** | Show sensor readings, battery, location | Shows integration with Android capabilities |
| **Cross-Device Sync** | Send message between devices on same network | Shows working communication without internet |

### 4. Impact & Scalability (30-45 seconds)
- **Cost:** Show it runs on repurposed Android phones
- **Open Source:** Point to MIT license and GitHub repo
- **Validation:** Mention 277+ tests passing
- **Scalability:** Show how cheap it is to deploy (RPi + LoRa vs satellite)
- **Google Integration:** Emphasize Android-first design and potential for Google ecosystem integration

## Demo Environment Setup

### Option 1: Single Device Demo
```bash
cd simulation/simulation
node server.js
# Open http://localhost:8000/index_integrated.html
```
- Enable airplane mode to show offline capability
- Show PWA installation
- Navigate through panels

### Option 2: Multi-Device Demo (More Impactful)
1. Start server on Device A (gateway or direct)
2. Connect Device B to same Wi-Fi/network
3. Open app on both devices
4. Trigger alert on one device
5. Show automatic discovery and communication

## Points to Emphasize for Google.org

- **Human Impact First:** Lead with lives saved, not technical specs
- **Accessibility:** "Works on the Android phone in your pocket" - no expensive hardware needed
- **Proven Solution:** 277+ tests, validated with PNUD Argentina
- **Open Source:** MIT license ensures global adoption
- **Scalable:** Can grow from 2 devices to community-wide mesh
- **Sustainable:** Communities can maintain it themselves
- **Android-First:** Targets regions where Android dominates
- **Low-Cost:** Orders of magnitude cheaper than satellite solutions

## Video Tips

Since you already have a video:
- **Keep it short:** 2-3 minutes is ideal for initial review
- **Show real functionality:** Demo actual features, not slides
- **Narrate in clear language:** Explain impact, not just features
- **Show offline capability:** This is the key differentiator
- **End with call to action:** Show GitHub repo and impact potential

## Repository Link

Always reference: [https://github.com/nicoleibson/UNVolunteers](https://github.com/nicoleibson/UNVolunteers)

## Additional Resources

- [README.md](../README.md) - Project overview
- [PITCH_GOOGLE_ORG_EN.md](PITCH_GOOGLE_ORG_EN.md) - Full proposal
- [ARCHITECTURE_SIMPLIFIED.md](ARCHITECTURE_SIMPLIFIED.md) - Technical architecture
- [DEPLOY_GATEWAY.md](../DEPLOY_GATEWAY.md) - Deployment instructions
- [MANUAL_PRUEBAS.md](../MANUAL_PRUEBAS.md) - Testing documentation
