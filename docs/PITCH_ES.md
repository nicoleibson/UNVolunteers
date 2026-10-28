# Propuesta para Google.org: Lifeline Core by Zentec

**Proyecto:** Lifeline Core  
**Iniciativa:** Zentec (startup en etapa inicial)  
**Solicitante:** Desarrollador único y autor  
**Repositorio:** [https://github.com/nicoleibson/UNVolunteers](https://github.com/nicoleibson/UNVolunteers)  
**Licencia:** MIT (Código Abierto)  
**Monto Solicitado:** Hasta $75,000 USD

---

## Resumen Ejecutivo

Cuando ocurren desastres, la infraestructura de comunicaciones es lo primero en fallar. **Lifeline Core** de **Zentec** proporciona una plataforma de comunicaciones autónoma y *offline-first* que crea redes en malla resilientes utilizando LoRa, Wi-Fi y tecnologías RF. Diseñada con enfoque *Android-first* y desplegable en hardware de bajo costo, permite a las comunidades y equipos de respuesta coordinar operaciones que salvan vidas cuando las redes celulares, internet y los canales de comunicación tradicionales no están disponibles.

---

## El Desafío

Los desastres causan apagones catastróficos de comunicación que dificultan gravemente las labores de rescate:

- **Pérdida de conectividad:** Las torres celulares se dañan o colapsan por sobrecarga en las primeras horas
- **Vulnerabilidad geográfica:** Las comunidades rurales y remotas suelen carecer de infraestructura de comunicaciones redundante
- **Barrera económica:** Las soluciones satelitales comerciales son prohibitivamente costosas para la mayoría de comunidades y brigadas voluntarias
- **Accesibilidad limitada:** Muchas regiones en riesgo dependen de smartphones Android económicos como su principal dispositivo tecnológico

---

## La Solución

Lifeline Core crea una **red de comunicación descentralizada y auto-reparable** que opera sin infraestructura externa:

- **Red en Malla:** La malla basada en LoRa conecta dispositivos a kilómetros de distancia sin cobertura celular
- **Gateway Autónomo:** Dispositivos Raspberry Pi/Orange Pi de bajo costo pueden crear puntos Wi-Fi locales formando hubs de comunicación
- **PWA Android-First:** Funciona en cualquier dispositivo Android desde el navegador o Termux, sin necesidad de distribución por tiendas de aplicaciones
- **Resiliencia Multi-Transporte:** Se adapta automáticamente entre LoRa, Wi-Fi Direct, WebRTC, APRS/AX.25 y SDR
- **Sin Conexión:** Totalmente funcional sin conectividad a internet
- **Almacén y Reenvío (DTN):** Capacidad para entregar mensajes cuando la red está fragmentada

---

## Diferenciación

| Característica | Lifeline Core | Soluciones Tradicionales |
| --- | --- | --- |
| **Costo** | $15-50 USD por nodo (usando smartphones Android reutilizados) | $500-5000+ USD por terminal satelital |
| **Infraestructura** | Completamente autónomo, no requiere infraestructura existente | Requiere infraestructura existente o costosa |
| **Accesibilidad** | Funciona en smartphones Android económicos | Requiere hardware especializado y costoso |
| **Código Abierto** | Licencia MIT, auditable y personalizable | Propietario, con dependencia del proveedor |
| **Descentralizado** | Sin punto único de falla | Centralizado o dependiente de proveedores |
| **Multi-Tecnología** | Stack integrado (LoRa, RF, PWA, WebRTC) | Generalmente soluciones de tecnología única |

---

## Tracción y Validación

- **Funcionalidad Comprobada:** Prototipo completamente funcional con stack RF completo implementado
- **Pruebas Robustas:** 277+ pruebas automatizadas sin fallos en todos los módulos
- **Validación Humanitaria:** Pruebas documentadas y colaboración con **PNUD Argentina**
- **Gateway Listo para Despliegue:** Documentación completa e instalador para Raspberry Pi/Orange Pi
- **Capacidades PWA:** Aplicación web instalable y offline-first lista para despliegue en campo
- **Desarrollo Continuo:** Validación constante mediante suites de pruebas comprehensivas

---

## Beneficiarios Objetivo

- **Comunidades Afectadas por Desastres:** Comunidades remotas y vulnerables en zonas propensas a desastres
- **Equipos de Primera Respuesta:** Protección civil, bomberos y servicios médicos de emergencia
- **Organizaciones Voluntarias:** Equipos de búsqueda y rescate con recursos limitados
- **Radioaficionados:** Operadores HAM que brindan comunicaciones de emergencia
- **Poblaciones Rurales:** Zonas con cobertura celular deficiente o inexistente, especialmente en América Latina

**Enfoque Inicial:** Comunidades propensas a desastres con alta penetración de dispositivos Android, comenzando en América Latina.

---

## Objetivos de Impacto

Con el apoyo de Google.org, buscamos alcanzar los siguientes resultados medibles:

| Objetivo | Meta | Plazo |
| --- | --- | --- |
| **Desplegar redes piloto** | 3-5 comunidades en zonas propensas a desastres | 12 meses |
| **Equipar equipos de respuesta** | Capacitar y equipar a más de 50 responders/voluntarios | 12 meses |
| **Despliegue de gateways** | Desplegar 10-15 gateways autónomos | 12 meses |
| **Alcance comunitario** | Beneficiar a más de 5,000 personas en comunidades piloto | 12 meses |
| **Transferencia de conocimiento** | Materiales de capacitación y documentación en español e inglés | Continuo |

---

## Solicitud de Financiamiento: $75,000 USD

Este financiamiento permitirá el despliegue piloto real y el impacto comunitario:

| Categoría | Monto (USD) | Justificación |
| --- | --- | --- |
| **Hardware LoRa (Gateways y Nodos)** | $25,000 | Raspberry Pi 5, transceptores LoRa (SX1276/SX1262), antenas, carcasas para 10-15 gateways |
| **Energía Solar y Baterías** | $20,000 | Paneles solares, baterías LiFePO4, controladores de carga para operación autónoma sin red |
| **Pruebas de Campo y Despliegue** | $15,000 | Viajes a comunidades piloto, logística, equipamiento de seguridad y pruebas en terreno |
| **Capacitación y Documentación** | $8,000 | Materiales de capacitación en español/inglés, talleres comunitarios y documentación técnica |
| **Varios y Contingencia** | $7,000 | Cables, conectores, herramientas, envío y gastos imprevistos |
| **Total** | **$75,000** | Máximo justificable para escala piloto inicial |

---

## Escalabilidad y Sostenibilidad

- **Replicación de Bajo Costo:** Una vez probado, las comunidades pueden replicarlo con hardware local o smartphones Android reutilizados
- **Modelo Open Source:** Licencia MIT permite adopción global sin costos de licencia
- **Propiedad Comunitaria:** La capacitación de voluntarios locales garantiza sostenibilidad a largo plazo
- **Ventaja Android-First:** Aprovecha dispositivos existentes, eliminando la necesidad de comprar smartphones
- **Diseño Modular:** Los componentes pueden agregarse incrementalmente según los recursos disponibles
- **Tecnología Comprobada:** Basado en protocolos estándar (LoRa, APRS, Wi-Fi) con amplia disponibilidad

---

## Equipo

**Desarrollador único y autor.** El proyecto se encuentra bajo **Zentec**, una iniciativa en etapa inicial enfocada en comunicaciones resilientes para respuesta a desastres. Al ser un desarrollador único con un prototipo funcional y metodología de pruebas comprobada, los recursos irán directamente al despliegue de hardware y al impacto comunitario, minimizando gastos administrativos.

---

## Llamado a Acción

Cada minuto sin comunicación en un desastre reduce las posibilidades de supervivencia. **Lifeline Core** cierra esta brecha crítica con tecnología accesible, económica y comprobada. Con el apoyo de Google.org, podemos transformar este prototipo open source en infraestructura que salva vidas para las comunidades que más lo necesitan.

**Juntos, podemos asegurar que cuando todo lo demás falla, las comunicaciones no fallen.**
