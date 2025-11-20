/**
 * SACS Embedded Checkout Widget
 * Plugin standalone para integrar carrito + checkout en cualquier sitio web
 * Versión: 1.6.0 - Múltiples instancias + configuraciones independientes
 */

(function(window) {
    'use strict';

    // Configuración
    const SACS_API_URL = 'https://api.sacscloud.com/v1';

    // Stripe Platform Publishable Key - Direct Charges con Stripe Connect
    const STRIPE_PUBLISHABLE_KEY = 'pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5';

    class SacsCheckout {
        constructor() {
            // Generar ID único para esta instancia
            this.instanceId = 'sacs-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            this.containerId = null; // Se establecerá en init()

            this.config = {
                accountId: null,
                configId: null,
                products: [],
                drawerStyles: {
                    backgroundColor: '#FFFFFF',
                    primaryTextColor: '#000000',
                    secondaryTextColor: '#6B7280',
                    buttonBgColor: '#000000',
                    buttonTextColor: '#FFFFFF',
                    buttonHoverColor: '#374151'
                },
                checkoutButtonStyles: {
                    text: 'Comprar Ahora',
                    bgColor: '#000000',
                    textColor: '#FFFFFF',
                    size: 'medium'
                }
            };
            this.cart = [];
            this.isOpen = false;
            this.currentStep = 1; // 1: Carrito, 2: Pago, 3: Firma (condicional), 4: Confirmar
            this.stripe = null;
            this.cardElement = null;
            this.customerInfo = {
                correo: '',
                nombre: '',
                direccion: '',
                ciudad: '',
                codigoPostal: ''
            };
            this.orderId = null;

            // Variables para manejo de firma
            this.isDrawing = false;
            this.lastX = 0;
            this.lastY = 0;
            this.firmaDibujada = false;
            this.firmaBase64 = null;
            this.paymentIntentId = null;
            this.paymentTotal = 0;
        }

        findAvailableContainer() {
            // Buscar contenedores con el ID sacs-checkout-button
            const containers = document.querySelectorAll('[id="sacs-checkout-button"]');

            if (containers.length === 0) {
                console.error('❌ No se encontró ningún contenedor con id="sacs-checkout-button"');
                return 'sacs-checkout-button';
            }

            // Buscar el primer contenedor que no tenga un botón ya renderizado
            for (let container of containers) {
                if (container.children.length === 0) {
                    return container.id;
                }
            }

            // Si todos están ocupados, usar el primero de todos modos
            return containers[0].id;
        }

        async init(options) {
            console.log('🔧 Init widget con opciones:', options);

            // Establecer containerId (usar el proporcionado o buscar el siguiente disponible)
            this.containerId = options.containerId || this.findAvailableContainer();
            console.log('📦 Usando containerId:', this.containerId);

            // Guardar accountId y configId
            this.config.accountId = options.accountId;
            this.config.configId = options.configId || null;

            // PASO 1: Cargar configuraciones desde MongoDB (si hay accountId)
            if (options.accountId) {
                console.log('📡 Cargando Stripe config...');
                await this.loadStripeConfig(options.accountId);

                console.log('📡 Cargando Account Defaults (almacén, sucursal, etc.)...');
                await this.loadAccountDefaults(options.accountId);

                console.log('📡 Cargando eCommerce config (productos, colores, etc.)...');
                await this.loadEcommerceConfig(options.accountId, options.configId);

                console.log('📡 Cargando Plantilla de Contratos...');
                await this.loadPlantillaContratos(options.accountId);
            }

            // PASO 2: Aplicar opciones del código embed (override MongoDB)
            // Prioridad: código embed > MongoDB > default
            if (options.products) this.config.products = options.products;

            // Drawer styles (mantener retrocompatibilidad)
            if (options.drawerStyles) {
                this.config.drawerStyles = {...this.config.drawerStyles, ...options.drawerStyles};
            }
            if (options.primaryColor) this.config.drawerStyles.backgroundColor = options.primaryColor;
            if (options.textColor) this.config.drawerStyles.primaryTextColor = options.textColor;
            if (options.secondaryTextColor) this.config.drawerStyles.secondaryTextColor = options.secondaryTextColor;

            // Checkout button styles (mantener retrocompatibilidad)
            if (options.checkoutButtonStyles) {
                this.config.checkoutButtonStyles = {...this.config.checkoutButtonStyles, ...options.checkoutButtonStyles};
            }
            if (options.buttonText) this.config.checkoutButtonStyles.text = options.buttonText;
            if (options.buttonBgColor) this.config.checkoutButtonStyles.bgColor = options.buttonBgColor;
            if (options.buttonTextColor) this.config.checkoutButtonStyles.textColor = options.buttonTextColor;
            if (options.buttonSize) this.config.checkoutButtonStyles.size = options.buttonSize;

            console.log('📦 Productos cargados:', this.config.products);
            console.log('🎨 Estilos drawer:', this.config.drawerStyles);
            console.log('🎨 Estilos botón checkout:', this.config.checkoutButtonStyles);

            // Inicializar carrito con productos preconfigurados
            this.cart = this.config.products.map(product => ({
                ...product,
                quantity: 1
            }));

            // Cargar Stripe.js (esperar a que termine)
            await this.loadStripe();

            // Inyectar estilos (después de tener todos los colores)
            this.injectStyles();

            // Renderizar botón (después de tener todos los colores)
            this.renderButton();
        }

        async loadEcommerceConfig(accountId, configId = null) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                // Construir el filtro: si hay configId, filtrar por id, sino solo por account
                const matchFilter = configId
                    ? { account: accountId, id: configId }
                    : { account: accountId };

                console.log('🔍 Buscando ecommerce config con filtro:', matchFilter);

                const response = await fetch(`${API_URL}/rest/${accountId}/ecommerceconfig/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            { $match: matchFilter },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const config = result.data[0];

                    // Guardar productos completos tal como vienen de MongoDB
                    this.config.products = await Promise.all((config.products || []).map(async p => {
                        // Solo cargar la imagen, mantener TODO lo demás intacto
                        const imageUrl = await this.loadProductImage(accountId, p.fid, p.tipo);

                        // Agregar la imagen cargada al producto sin modificar nada más
                        return {
                            ...p,
                            imageUrl: imageUrl // Agregar imagen cargada
                        };
                    }));

                    // Cargar estilos del drawer
                    if (config.drawerStyles) {
                        this.config.drawerStyles = {...this.config.drawerStyles, ...config.drawerStyles};
                    }

                    // Cargar estilos del botón de checkout
                    if (config.checkoutButtonStyles) {
                        this.config.checkoutButtonStyles = {...this.config.checkoutButtonStyles, ...config.checkoutButtonStyles};
                    }

                    console.log('✓ Configuración de eCommerce cargada desde MongoDB');
                }
            } catch (error) {
                console.error('Error cargando configuración de eCommerce:', error);
            }
        }

        async loadStripeConfig(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const response = await fetch(`${API_URL}/rest/${accountId}/stripe_config/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            { $match: { _id: 'stripe' } },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const stripeConfig = result.data[0];
                    this.config.stripeAccountId = stripeConfig.stripeAccountId;
                    console.log('✓ Stripe Account ID:', this.config.stripeAccountId);
                } else {
                    console.error('No se encontró configuración de Stripe para esta cuenta');
                }
            } catch (error) {
                console.error('Error cargando configuración de Stripe:', error);
            }
        }

        async loadAccountDefaults(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                // Los defaults están en store_config de admin con filtro por account
                const response = await fetch(`${API_URL}/rest/admin/store_config?limit=1&account=${accountId}&isActive=true`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const config = result.data[0];

                    if (config && config.defaults) {
                        this.config.accountDefaults = config.defaults;
                        console.log('✓ Account Defaults cargados:', config.defaults);
                    } else {
                        throw new Error('No se encontró configuración de defaults para esta cuenta');
                    }
                } else {
                    throw new Error('Error al obtener store_config');
                }
            } catch (error) {
                console.error('Error cargando account defaults:', error);
                throw error;
            }
        }

        async loadPlantillaContratos(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const response = await fetch(`${API_URL}/rest/${accountId}/plantillas_contratos/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            {
                                $match: {
                                    account: accountId,
                                    estado: 'activa',
                                    'config.general.opcionesEnvio.enPedido': true
                                }
                            },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    this.config.plantillaContratos = result.data[0];
                    console.log('✓ Plantilla de contratos cargada:', this.config.plantillaContratos.nombre);
                } else {
                    console.log('ℹ️ No hay plantilla de contratos activa configurada para envío en pedidos');
                    this.config.plantillaContratos = null;
                }
            } catch (error) {
                console.error('Error cargando plantilla de contratos:', error);
                this.config.plantillaContratos = null;
            }
        }

        requiereFirma() {
            if (!this.config.plantillaContratos) return false;
            if (!this.config.plantillaContratos.config) return false;
            if (!this.config.plantillaContratos.config.general) return false;
            return this.config.plantillaContratos.config.general.requiereFirma === true;
        }

        async loadProductImage(accountId, productKey, productType) {
            const API_URL = 'https://api.sacscloud.com/v1';

            try {
                const response = await fetch(`${API_URL}/articulos/getImagen`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        account: accountId,
                        key: productKey,
                        tipo: productType || 'Producto Simple'
                    })
                });

                if (!response.ok) {
                    throw new Error('Error al obtener imagen del producto');
                }

                const data = await response.json();

                if (data.success && data.data) {
                    return data.data;
                } else {
                    // Si no hay imagen, retornar null (usaremos placeholder)
                    return null;
                }
            } catch (error) {
                console.error('Error cargando imagen del producto:', error);
                return null;
            }
        }

        getProductInitial(productName) {
            if (!productName || typeof productName !== 'string') return '?';
            return productName.trim().charAt(0).toUpperCase();
        }

        renderButton() {
            const container = document.getElementById(this.containerId);
            if (!container) {
                console.warn(`⚠️ Contenedor no encontrado: ${this.containerId}`);
                return;
            }

            const button = document.createElement('button');
            const styles = this.config.checkoutButtonStyles;
            button.textContent = styles.text || 'Comprar Ahora';

            const padding = styles.size === 'small' ? '8px 16px'
                          : styles.size === 'large' ? '16px 32px'
                          : '12px 24px';

            const fontSize = styles.size === 'small' ? '13px'
                           : styles.size === 'large' ? '18px'
                           : '15px';

            button.style.cssText = `
                background: ${styles.bgColor || '#000000'};
                color: ${styles.textColor || '#FFFFFF'};
                padding: ${padding};
                font-size: ${fontSize};
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                font-family: inherit;
                transition: opacity 0.2s;
            `;

            button.onmouseover = () => button.style.opacity = '0.9';
            button.onmouseout = () => button.style.opacity = '1';
            button.onclick = () => this.open();

            container.appendChild(button);
        }

        async loadStripe() {
            // Esperar si todavía no tenemos el stripeAccountId
            let attempts = 0;
            while (!this.config.stripeAccountId && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            if (!this.config.stripeAccountId) {
                console.error('No se pudo obtener el Stripe Account ID');
                return;
            }

            // Cargar Stripe.js si no está cargado
            if (!window.Stripe) {
                const script = document.createElement('script');
                script.src = 'https://js.stripe.com/v3/';
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            // Inicializar Stripe con el stripeAccountId del tenant (Direct Charge)
            this.stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY, {
                stripeAccount: this.config.stripeAccountId
            });

            console.log('✓ Stripe inicializado con cuenta:', this.config.stripeAccountId);
        }

        injectStyles() {
            // Buscar o crear el elemento de estilos
            let style = document.getElementById('sacs-checkout-styles');

            if (!style) {
                style = document.createElement('style');
                style.id = 'sacs-checkout-styles';
                document.head.appendChild(style);
            }

            // Actualizar los estilos (se actualizan en cada instancia)
            style.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

                .sacs-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 999998;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                }

                .sacs-overlay.active {
                    opacity: 1;
                }

                .sacs-drawer {
                    position: fixed;
                    top: 0;
                    right: 0;
                    bottom: 0;
                    width: 100%;
                    max-width: 640px;
                    background: ${this.config.drawerStyles.backgroundColor || '#1F2937'};
                    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
                    z-index: 999999;
                    transform: translateX(100%);
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    display: flex;
                    flex-direction: column;
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-drawer.active {
                    transform: translateX(0);
                }

                .sacs-drawer-header {
                    padding: 32px 32px 24px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    position: relative;
                }

                .sacs-close-btn {
                    position: absolute;
                    top: 24px;
                    right: 24px;
                    background: none;
                    border: none;
                    width: 32px;
                    height: 32px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    transition: opacity 0.2s;
                }

                .sacs-close-btn:hover {
                    opacity: 1;
                }

                .sacs-drawer-title {
                    font-size: 32px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 32px 0;
                }

                .sacs-stepper {
                    display: flex;
                    gap: 24px;
                    align-items: center;
                }

                .sacs-step {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    transition: all 0.3s;
                }

                .sacs-step.active {
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    opacity: 1;
                }

                .sacs-step.completed {
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    opacity: 1;
                }

                .sacs-step-number {
                    width: 40px;
                    height: 40px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 18px;
                    background: #F3F4F6;
                    color: #9CA3AF;
                    transition: all 0.3s;
                }

                .sacs-step.active .sacs-step-number {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-step.completed .sacs-step-number {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-step-check {
                    width: 20px;
                    height: 20px;
                    stroke: white;
                    stroke-width: 3;
                }

                .sacs-drawer-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 32px;
                }

                .sacs-cart-item {
                    display: flex;
                    gap: 20px;
                    padding: 24px;
                    margin-bottom: 16px;
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                }

                .sacs-cart-item:first-child {
                    padding: 24px;
                }

                .sacs-item-image {
                    width: 80px;
                    height: 80px;
                    object-fit: cover;
                    border-radius: 8px;
                    background: #F3F4F6;
                    flex-shrink: 0;
                }

                .sacs-item-placeholder {
                    width: 80px;
                    height: 80px;
                    border-radius: 8px;
                    background: linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%);
                    border: 1px solid #93C5FD;
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    font-size: 32px;
                    color: #1E40AF;
                    text-transform: uppercase;
                    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
                }

                .sacs-item-info {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .sacs-item-name {
                    font-weight: 600;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0;
                }

                .sacs-item-variant {
                    font-size: 14px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-item-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-top: auto;
                }

                .sacs-quantity-control {
                    display: flex;
                    align-items: center;
                    gap: 0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    overflow: hidden;
                    background: rgba(255, 255, 255, 0.05);
                }

                .sacs-qty-btn {
                    width: 40px;
                    height: 40px;
                    border: none;
                    background: transparent;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    transition: background 0.2s;
                    border-right: 1px solid rgba(255, 255, 255, 0.2);
                }

                .sacs-qty-btn:last-child {
                    border-right: none;
                    border-left: 1px solid rgba(255, 255, 255, 0.2);
                }

                .sacs-qty-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .sacs-qty-btn:disabled {
                    opacity: 0.3;
                    cursor: not-allowed;
                }

                .sacs-qty-display {
                    width: 40px;
                    text-align: center;
                    font-weight: 500;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-item-price {
                    font-weight: 600;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-drawer-footer {
                    padding: 24px 32px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    background: ${this.config.drawerStyles.backgroundColor || '#1F2937'};
                }

                .sacs-summary {
                    margin-bottom: 24px;
                }

                .sacs-summary-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 12px;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                }

                .sacs-summary-row.total {
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    font-size: 20px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-btn {
                    width: 100%;
                    padding: 16px;
                    border: none;
                    border-radius: 4px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    font-family: inherit;
                }

                .sacs-btn-primary {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-btn-primary:hover {
                    background: ${this.config.drawerStyles.buttonHoverColor || '#374151'};
                }

                .sacs-btn-primary:disabled {
                    background: #9CA3AF;
                    cursor: not-allowed;
                }

                .sacs-section-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin: 0 0 16px 0;
                }

                .sacs-form-group {
                    margin-bottom: 20px;
                }

                .sacs-form-label {
                    display: block;
                    font-size: 15px;
                    font-weight: 500;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin-bottom: 8px;
                }

                .sacs-form-input {
                    width: 100%;
                    padding: 12px 16px;
                    border: 1px solid ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    border-radius: 4px;
                    font-size: 15px;
                    font-family: inherit;
                    transition: all 0.2s;
                    background: transparent;
                    box-sizing: border-box;
                    color: ${this.config.drawerStyles.primaryTextColor || '#000000'};
                }

                .sacs-form-input::placeholder {
                    color: ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    opacity: 0.6;
                }

                .sacs-form-input:focus {
                    outline: none;
                    border-color: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                }

                .sacs-form-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 16px;
                }

                .sacs-back-btn {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: none;
                    border: none;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    cursor: pointer;
                    padding: 0;
                    margin-bottom: 32px;
                    font-family: inherit;
                    font-weight: 500;
                }

                .sacs-back-btn:hover {
                    opacity: 1;
                }

                .sacs-page-title {
                    font-size: 32px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 32px 0;
                }

                .sacs-success-container {
                    text-align: center;
                    padding: 48px 0;
                }

                .sacs-success-icon {
                    width: 80px;
                    height: 80px;
                    margin: 0 auto 32px;
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .sacs-success-check {
                    width: 48px;
                    height: 48px;
                    stroke: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                    stroke-width: 3;
                }

                .sacs-success-title {
                    font-size: 28px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 12px 0;
                }

                .sacs-success-subtitle {
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0 0 32px 0;
                }

                .sacs-order-box {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    padding: 32px;
                    border-radius: 8px;
                    margin-bottom: 32px;
                }

                .sacs-order-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin: 0 0 8px 0;
                }

                .sacs-order-number {
                    font-size: 24px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 16px 0;
                }

                .sacs-order-total {
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-qr-container {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 16px;
                }

                .sacs-qr-code {
                    width: 200px;
                    height: 200px;
                    background: white;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 8px;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                }

                .sacs-barcode {
                    width: 300px;
                    height: 60px;
                    background: transparent;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .sacs-info-box {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    padding: 20px;
                    border-radius: 8px;
                    margin-bottom: 16px;
                    display: flex;
                    gap: 16px;
                }

                .sacs-info-icon {
                    width: 24px;
                    height: 24px;
                    flex-shrink: 0;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                }

                .sacs-info-content {
                    flex: 1;
                }

                .sacs-info-title {
                    font-size: 15px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 4px 0;
                }

                .sacs-info-text {
                    font-size: 14px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-payment-icons {
                    display: flex;
                    gap: 12px;
                    justify-content: center;
                    margin-top: 16px;
                    padding-top: 16px;
                    border-top: 1px solid #E5E7EB;
                }

                .sacs-payment-icon {
                    width: 50px;
                    height: 32px;
                    object-fit: contain;
                    opacity: 0.6;
                }

                .sacs-secure-text {
                    text-align: center;
                    font-size: 13px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin-top: 12px;
                }

                .sacs-spinner {
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    border-top: 2px solid white;
                    border-radius: 50%;
                    width: 16px;
                    height: 16px;
                    animation: sacs-spin 1s linear infinite;
                }

                @keyframes sacs-spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }

                .sacs-error-message {
                    background: #FEE2E2;
                    color: #DC2626;
                    padding: 12px 16px;
                    border-radius: 4px;
                    margin-bottom: 16px;
                    font-size: 14px;
                }

                .sacs-stripe-element {
                    padding: 12px 16px;
                    border: 1px solid ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    border-radius: 4px;
                    background: transparent;
                }

                @media (max-width: 640px) {
                    .sacs-drawer {
                        max-width: 100%;
                    }

                    .sacs-drawer-title {
                        font-size: 24px;
                    }

                    .sacs-page-title {
                        font-size: 24px;
                    }

                    .sacs-form-row {
                        grid-template-columns: 1fr;
                    }

                    .sacs-stepper {
                        gap: 12px;
                    }

                    .sacs-step-label {
                        display: none;
                    }

                    .sacs-doc-info {
                        font-size: 14px;
                    }

                    .sacs-firma-instructions {
                        font-size: 13px;
                        padding: 0.75rem;
                    }

                    .sacs-canvas-container {
                        padding: 0.75rem;
                    }

                    #sacs-signature-canvas {
                        max-width: 100%;
                        height: 150px;
                    }

                    .sacs-firma-actions {
                        flex-direction: column;
                        gap: 0.5rem;
                    }

                    .sacs-firma-actions button {
                        width: 100%;
                    }
                }

                /* ==================== ESTILOS PARA FIRMA DIGITAL ==================== */

                .sacs-doc-info {
                    background: rgba(255, 255, 255, 0.05);
                    padding: 1rem;
                    border-radius: 8px;
                    margin-bottom: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .sacs-doc-info p {
                    margin: 0.5rem 0;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    font-size: 15px;
                    line-height: 1.6;
                }

                .sacs-doc-info strong {
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    font-weight: 600;
                }

                .sacs-firma-instructions {
                    background: rgba(59, 130, 246, 0.1);
                    border-left: 4px solid #3B82F6;
                    padding: 1rem;
                    margin-bottom: 1.5rem;
                    border-radius: 4px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-firma-instructions p {
                    margin: 0;
                    font-size: 14px;
                    line-height: 1.5;
                }

                .sacs-canvas-container {
                    position: relative;
                    border: 2px dashed rgba(255, 255, 255, 0.2);
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.03);
                    padding: 1rem;
                    margin-bottom: 1.5rem;
                }

                #sacs-signature-canvas {
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    cursor: crosshair;
                    touch-action: none;
                    background: #FFFFFF;
                    width: 100%;
                    max-width: 540px;
                    height: 200px;
                    display: block;
                }

                .sacs-canvas-placeholder {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: #9CA3AF;
                    pointer-events: none;
                    font-size: 0.875rem;
                    text-align: center;
                }

                .sacs-canvas-placeholder.hidden {
                    display: none;
                }

                .sacs-firma-actions {
                    display: flex;
                    gap: 0.75rem;
                    justify-content: flex-end;
                }

                .sacs-btn-secondary {
                    padding: 0.75rem 1.5rem;
                    background: rgba(255, 255, 255, 0.1);
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    font-weight: 600;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 15px;
                    transition: all 0.2s;
                }

                .sacs-btn-secondary:hover {
                    background: rgba(255, 255, 255, 0.15);
                }

                .sacs-btn-primary {
                    padding: 0.75rem 1.5rem;
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                    border: none;
                    border-radius: 6px;
                    font-weight: 600;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 15px;
                    transition: all 0.2s;
                }

                .sacs-btn-primary:hover:not(:disabled) {
                    opacity: 0.9;
                }

                .sacs-btn-primary:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* ==================== FIN ESTILOS PARA FIRMA DIGITAL ==================== */
            `;
        }

        open() {
            if (this.isOpen) return;

            this.isOpen = true;
            this.currentStep = 1;
            this.render();

            // Abrir con animación
            requestAnimationFrame(() => {
                const overlay = document.getElementById('sacs-overlay');
                const drawer = document.getElementById('sacs-drawer');
                if (overlay) overlay.classList.add('active');
                if (drawer) drawer.classList.add('active');
            });
        }

        close() {
            console.log('CLOSE llamado - stack trace:');
            console.trace();

            const overlay = document.getElementById('sacs-overlay');
            const drawer = document.getElementById('sacs-drawer');

            if (overlay) overlay.classList.remove('active');
            if (drawer) drawer.classList.remove('active');

            setTimeout(() => {
                this.isOpen = false;
                if (overlay) overlay.remove();
                if (drawer) drawer.remove();
            }, 300);
        }

        render() {
            // Si ya existe el drawer, solo actualizar contenido
            let existingDrawer = document.getElementById('sacs-drawer');
            let existingOverlay = document.getElementById('sacs-overlay');

            if (existingDrawer) {
                // Solo actualizar el contenido del drawer
                existingDrawer.innerHTML = this.getDrawerContent();
                this.attachEventListeners();
                return;
            }

            // Primera vez: crear overlay y drawer
            // Crear overlay
            const overlay = document.createElement('div');
            overlay.id = 'sacs-overlay';
            overlay.className = 'sacs-overlay';
            overlay.onclick = (e) => {
                // Solo cerrar si se hace clic directamente en el overlay, no en el drawer
                if (e.target === overlay) {
                    this.close();
                }
            };
            document.body.appendChild(overlay);

            // Crear drawer
            const drawer = document.createElement('div');
            drawer.id = 'sacs-drawer';
            drawer.className = 'sacs-drawer';
            drawer.innerHTML = this.getDrawerContent();
            document.body.appendChild(drawer);

            // Agregar event listeners
            this.attachEventListeners();
        }

        getDrawerContent() {
            return `
                <div class="sacs-drawer-header">
                    <button class="sacs-close-btn" onclick="sacsCheckout.close()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                    <h1 class="sacs-drawer-title">Carrito de Compras <span style="font-size: 14px; opacity: 0.5; font-weight: 400;">v1.6.0</span></h1>
                    ${this.renderStepper()}
                </div>
                ${this.renderBody()}
                ${this.renderFooter()}
            `;
        }

        renderStepper() {
            const requiereFirma = this.requiereFirma();
            // Nueva estructura: 1→2→3(firma condicional)→4(pago)→5(confirmar)
            // Sin firma: 1→2→4→5

            return `
                <div class="sacs-stepper">
                    <!-- Paso 1: Carrito -->
                    <div class="sacs-step ${this.currentStep >= 1 ? 'active' : ''} ${this.currentStep > 1 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 1 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '1'}
                        </div>
                        <span class="sacs-step-label">Carrito</span>
                    </div>

                    <!-- Paso 2: Información -->
                    <div class="sacs-step ${this.currentStep >= 2 ? 'active' : ''} ${this.currentStep > 2 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 2 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '2'}
                        </div>
                        <span class="sacs-step-label">Info</span>
                    </div>

                    <!-- Paso 3: Firma (condicional) -->
                    ${requiereFirma ? `
                        <div class="sacs-step ${this.currentStep >= 3 ? 'active' : ''} ${this.currentStep > 3 ? 'completed' : ''}">
                            <div class="sacs-step-number">
                                ${this.currentStep > 3 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '3'}
                            </div>
                            <span class="sacs-step-label">Firma</span>
                        </div>
                    ` : ''}

                    <!-- Paso 4: Pago (SIEMPRE, FIJO) -->
                    <div class="sacs-step ${this.currentStep >= 4 ? 'active' : ''} ${this.currentStep > 4 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 4 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : (requiereFirma ? '4' : '3')}
                        </div>
                        <span class="sacs-step-label">Pago</span>
                    </div>

                    <!-- Paso 5: Confirmar -->
                    <div class="sacs-step ${this.currentStep >= 5 ? 'active' : ''}">
                        <div class="sacs-step-number">${requiereFirma ? '5' : '4'}</div>
                        <span class="sacs-step-label">Confirmar</span>
                    </div>
                </div>
            `;
        }

        renderBody() {
            const requiereFirma = this.requiereFirma();

            switch (this.currentStep) {
                case 1:
                    return this.renderCart();
                case 2:
                    return this.renderInfoCliente();
                case 3:
                    // Paso 3 solo existe si requiere firma
                    return this.renderFirma();
                case 4:
                    // Paso 4 es SIEMPRE pago
                    return this.renderPago();
                case 5:
                    // Paso 5 es confirmación
                    return this.renderSuccess();
                default:
                    return this.renderCart();
            }
        }

        renderCart() {
            return `
                <div class="sacs-drawer-body">
                    ${this.cart.map((item, index) => `
                        <div class="sacs-cart-item">
                            ${item.imageUrl
                                ? `<img class="sacs-item-image" src="${item.imageUrl}" alt="${item.nombre}">`
                                : `<div class="sacs-item-placeholder">
                                    ${this.getProductInitial(item.nombre)}
                                   </div>`
                            }
                            <div class="sacs-item-info">
                                <h3 class="sacs-item-name">${item.nombre}</h3>
                                <p class="sacs-item-variant">${item.variant || 'Sin variante'}</p>
                                <div class="sacs-item-footer">
                                    <div class="sacs-quantity-control">
                                        <button class="sacs-qty-btn" onclick="sacsCheckout.updateQuantity(${index}, ${item.quantity - 1})" ${item.quantity <= 1 ? 'disabled' : ''}>−</button>
                                        <span class="sacs-qty-display">${item.quantity}</span>
                                        <button class="sacs-qty-btn" onclick="sacsCheckout.updateQuantity(${index}, ${item.quantity + 1})">+</button>
                                    </div>
                                    <span class="sacs-item-price">$${(parseFloat(item.precio) * item.quantity).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        renderInfoCliente() {
            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.goToStep(1)">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>
                    <h2 class="sacs-page-title">Información de Envío</h2>

                    <div id="sacs-error-container"></div>

                    <div style="margin-bottom: 32px;">
                        <h3 class="sacs-section-title">CONTACTO</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Correo Electrónico</label>
                            <input type="email" class="sacs-form-input" id="sacs-correo" value="${this.customerInfo.correo}" placeholder="tu@correo.com" required>
                        </div>
                    </div>

                    <div style="margin-bottom: 32px;">
                        <h3 class="sacs-section-title">ENVÍO</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Nombre Completo</label>
                            <input type="text" class="sacs-form-input" id="sacs-nombre" value="${this.customerInfo.nombre}" placeholder="Juan Pérez" required>
                        </div>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Dirección</label>
                            <input type="text" class="sacs-form-input" id="sacs-direccion" value="${this.customerInfo.direccion}" placeholder="Calle Principal 123" required>
                        </div>
                        <div class="sacs-form-row">
                            <div class="sacs-form-group">
                                <label class="sacs-form-label">Ciudad</label>
                                <input type="text" class="sacs-form-input" id="sacs-ciudad" value="${this.customerInfo.ciudad}" placeholder="Ciudad de México" required>
                            </div>
                            <div class="sacs-form-group">
                                <label class="sacs-form-label">Código Postal</label>
                                <input type="text" class="sacs-form-input" id="sacs-cp" value="${this.customerInfo.codigoPostal}" placeholder="01000" required>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        renderPago() {
            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.volverDesdePago()">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>
                    <h2 class="sacs-page-title">Pago</h2>

                    <div id="sacs-error-container"></div>

                    <div>
                        <h3 class="sacs-section-title">INFORMACIÓN DE PAGO</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Número de Tarjeta</label>
                            <div id="card-element" class="sacs-stripe-element"></div>
                        </div>
                    </div>
                </div>
            `;
        }

        renderFirma() {
            const plantilla = this.config.plantillaContratos;
            const titulo = plantilla?.contenidoInfo?.titulo || 'Documento de Firma';

            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.goToStep(2)">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>

                    <h2 class="sacs-page-title">Firma del Documento</h2>

                    <div class="sacs-doc-info">
                        <p><strong>Documento:</strong> ${titulo}</p>
                        <p><strong>Cliente:</strong> ${this.customerInfo.nombre}</p>
                        <p><strong>Fecha:</strong> ${new Date().toLocaleDateString('es-MX', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        })}</p>
                    </div>

                    <div class="sacs-firma-instructions">
                        <p>✍️ Por favor, dibuje su firma en el recuadro de abajo usando el mouse o su dedo (en pantallas táctiles).</p>
                    </div>

                    <div class="sacs-canvas-container">
                        <canvas id="sacs-signature-canvas" width="540" height="200"></canvas>
                        <div id="sacs-canvas-placeholder" class="sacs-canvas-placeholder">
                            Dibuje su firma aquí
                        </div>
                    </div>

                    <div class="sacs-firma-actions">
                        <button class="sacs-btn sacs-btn-secondary" onclick="sacsCheckout.limpiarFirma()">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="1 4 1 10 7 10"></polyline>
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                            </svg>
                            Limpiar
                        </button>
                        <button id="sacs-confirmar-firma-btn" class="sacs-btn sacs-btn-primary" onclick="sacsCheckout.confirmarFirma()" disabled>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                            Confirmar Firma
                        </button>
                    </div>
                </div>
            `;
        }

        renderSuccess() {
            const total = this.calculateTotal();
            const orderNumber = this.orderId || 'ORD' + Date.now();

            // Generar códigos después de renderizar
            setTimeout(() => this.generateCodes(orderNumber, total), 100);

            return `
                <div class="sacs-drawer-body">
                    <div class="sacs-success-container">
                        <div class="sacs-success-icon">
                            <svg class="sacs-success-check" viewBox="0 0 24 24" fill="none">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </div>
                        <h2 class="sacs-success-title">¡Felicidades!</h2>
                        <p class="sacs-success-subtitle">Tu pedido ha sido confirmado</p>

                        <div class="sacs-order-box">
                            <p class="sacs-order-label">NÚMERO DE PEDIDO</p>
                            <h3 class="sacs-order-number">#${orderNumber}</h3>
                            <p class="sacs-order-total">Total: $${total.toFixed(2)}</p>
                        </div>

                        <div class="sacs-qr-container">
                            <div class="sacs-qr-code" id="sacs-qr-code"></div>
                            <div class="sacs-barcode" id="sacs-barcode"></div>
                        </div>

                        <div style="margin-top: 32px;">
                            <div class="sacs-info-box">
                                <svg class="sacs-info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title">Toma una foto de esta pantalla</h4>
                                    <p class="sacs-info-text">Guarda esta confirmación para tus registros</p>
                                </div>
                            </div>
                            <div class="sacs-info-box">
                                <svg class="sacs-info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                                    <polyline points="22,6 12,13 2,6"></polyline>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title">Revisa tu correo</h4>
                                    <p class="sacs-info-text">Te hemos enviado una confirmación con código QR y todos los detalles del pedido</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        async generateCodes(orderNumber, total) {
            // Cargar librerías desde CDN si no están cargadas
            await this.loadQRLibrary();
            await this.loadBarcodeLibrary();

            // Generar los códigos
            this.generateQRCode(orderNumber, total);
            this.generateBarcode(orderNumber);
        }

        async loadQRLibrary() {
            if (window.QRCode) return;

            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        async loadBarcodeLibrary() {
            if (window.JsBarcode) return;

            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        generateQRCode(orderNumber, total) {
            const qrContainer = document.getElementById('sacs-qr-code');
            if (!qrContainer || !window.QRCode) return;

            // Limpiar contenedor
            qrContainer.innerHTML = '';

            // Datos del QR: número de orden y total
            const qrData = `Pedido: ${orderNumber}\nTotal: $${total.toFixed(2)}`;

            // Generar QR Code
            new QRCode(qrContainer, {
                text: qrData,
                width: 180,
                height: 180,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });
        }

        generateBarcode(orderNumber) {
            const barcodeContainer = document.getElementById('sacs-barcode');
            if (!barcodeContainer || !window.JsBarcode) return;

            // Limpiar contenedor
            barcodeContainer.innerHTML = '';

            // Crear elemento SVG para el código de barras
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'sacs-barcode-svg');
            barcodeContainer.appendChild(svg);

            // Convertir número de orden a código numérico (solo números)
            const numericCode = orderNumber.replace(/[^0-9]/g, '').slice(0, 12);

            // Generar código de barras
            try {
                JsBarcode(svg, numericCode, {
                    format: 'CODE128',
                    width: 2,
                    height: 50,
                    displayValue: true,
                    fontSize: 12,
                    margin: 5
                });
            } catch (error) {
                console.error('Error generando código de barras:', error);
            }
        }

        renderFooter() {
            // Paso 2: Info del cliente - Solo botón sin resumen
            if (this.currentStep === 2) {
                return `
                    <div class="sacs-drawer-footer">
                        <button class="sacs-btn sacs-btn-primary" id="sacs-pay-btn">
                            <span id="sacs-btn-text">Continuar</span>
                        </button>
                    </div>
                `;
            }

            // Paso 3: Firma - Sin footer (botones dentro del body)
            if (this.currentStep === 3) {
                return '';
            }

            // Paso 5: Confirmación - Solo botón para cerrar
            if (this.currentStep === 5) {
                return `
                    <div class="sacs-drawer-footer">
                        <button class="sacs-btn sacs-btn-primary" onclick="sacsCheckout.close()">
                            Continuar Comprando
                        </button>
                    </div>
                `;
            }

            // Paso 1 (Carrito) y Paso 4 (Pago): Mostrar resumen de precios
            const total = this.calculateTotal();
            const subtotal = total / 1.16; // IVA 16%
            const taxes = total - subtotal;

            return `
                <div class="sacs-drawer-footer">
                    <div class="sacs-summary">
                        <div class="sacs-summary-row">
                            <span>Subtotal</span>
                            <span>$${subtotal.toFixed(2)}</span>
                        </div>
                        <div class="sacs-summary-row">
                            <span>Impuestos</span>
                            <span>$${taxes.toFixed(2)}</span>
                        </div>
                        <div class="sacs-summary-row total">
                            <span>Total</span>
                            <span>$${total.toFixed(2)}</span>
                        </div>
                    </div>
                    <button class="sacs-btn sacs-btn-primary" id="sacs-pay-btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect>
                            <line x1="1" y1="10" x2="23" y2="10"></line>
                        </svg>
                        <span id="sacs-btn-text">${this.currentStep === 1 ? 'Continuar' : 'Completar Compra'}</span>
                        <span id="sacs-btn-spinner" style="display: none;" class="sacs-spinner"></span>
                    </button>
                    ${this.currentStep === 1 ? `
                        <div class="sacs-payment-icons">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%231434CB' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='20' font-family='Arial' font-size='12' font-weight='bold' fill='white' text-anchor='middle'%3EVISA%3C/text%3E%3C/svg%3E" alt="Visa">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23EB001B' width='48' height='32' rx='4'/%3E%3Ccircle cx='18' cy='16' r='8' fill='%23EB001B'/%3E%3Ccircle cx='30' cy='16' r='8' fill='%23F79E1B'/%3E%3C/svg%3E" alt="Mastercard">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23016FD0' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='20' font-family='Arial' font-size='10' font-weight='bold' fill='white' text-anchor='middle'%3EAMEX%3C/text%3E%3C/svg%3E" alt="American Express">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23003087' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='14' font-family='Arial' font-size='8' font-weight='bold' fill='%23009CDE' text-anchor='middle'%3EPayPal%3C/text%3E%3C/svg%3E" alt="PayPal">
                        </div>
                        <p class="sacs-secure-text">Pago seguro • ¡Consíguelo antes de que se agote! • v1.6.0</p>
                    ` : ''}
                </div>
            `;
        }

        attachEventListeners() {
            // Event listener para el botón de pagar/completar compra
            const payBtn = document.getElementById('sacs-pay-btn');
            console.log('Attach listeners - payBtn:', payBtn, 'currentStep:', this.currentStep);

            if (payBtn) {
                payBtn.addEventListener('click', (e) => {
                    console.log('Click en botón - currentStep:', this.currentStep);
                    e.preventDefault();
                    e.stopPropagation();

                    if (this.currentStep === 1) {
                        // Paso 1: Ir a paso 2 (info cliente)
                        console.log('Ir a paso 2 (info cliente)');
                        this.goToStep(2);

                    } else if (this.currentStep === 2) {
                        // Paso 2: Capturar info y decidir siguiente paso
                        console.log('Capturando info del cliente...');

                        // Capturar info del formulario
                        this.customerInfo = {
                            correo: document.getElementById('sacs-correo').value.trim(),
                            nombre: document.getElementById('sacs-nombre').value.trim(),
                            direccion: document.getElementById('sacs-direccion').value.trim(),
                            ciudad: document.getElementById('sacs-ciudad').value.trim(),
                            codigoPostal: document.getElementById('sacs-cp').value.trim()
                        };

                        if (!this.validateCustomerInfo()) {
                            this.showError('Por favor completa todos los campos');
                            return;
                        }

                        // Decidir: ¿Requiere firma?
                        if (this.requiereFirma()) {
                            console.log('Ir a paso 3 (firma)');
                            this.goToStep(3);
                        } else {
                            console.log('Ir a paso 4 (pago)');
                            this.goToStep(4);
                        }

                    } else if (this.currentStep === 4) {
                        // Paso 4: Procesar pago
                        console.log('Procesar pago');
                        this.processPayment();
                    }
                });
            }

            // Inicializar canvas de firma si estamos en paso 3
            if (this.currentStep === 3) {
                setTimeout(() => this.initCanvasFirma(), 100);
            }

            // Inicializar Stripe si estamos en paso 4
            if (this.currentStep === 4) {
                setTimeout(() => this.initStripeElements(), 100);
            }
        }

        initStripeElements() {
            if (!this.stripe) {
                console.error('Stripe no está cargado');
                return;
            }

            const elements = this.stripe.elements();
            this.cardElement = elements.create('card', {
                style: {
                    base: {
                        fontSize: '15px',
                        color: '#111827',
                        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
                        '::placeholder': {
                            color: '#9CA3AF'
                        }
                    }
                },
                hidePostalCode: true
            });

            this.cardElement.mount('#card-element');
        }

        updateQuantity(index, newQuantity) {
            if (newQuantity < 1) return;
            this.cart[index].quantity = newQuantity;
            this.render();
        }

        calculateTotal() {
            return this.cart.reduce((total, item) => {
                const precio = parseFloat(item.precio) || 0;
                const cantidad = parseInt(item.quantity) || 0;
                return total + (precio * cantidad);
            }, 0);
        }

        goToStep(step) {
            console.log('goToStep llamado - de', this.currentStep, 'a', step);
            this.currentStep = step;
            this.render();

            // Re-enfocar en el drawer después de cambiar de paso
            requestAnimationFrame(() => {
                const drawer = document.getElementById('sacs-drawer');
                if (drawer) {
                    drawer.scrollTop = 0; // Scroll al inicio
                }
            });
        }

        // ==================== MÉTODOS DEL CANVAS DE FIRMA ====================

        initCanvasFirma() {
            const canvas = document.getElementById('sacs-signature-canvas');
            if (!canvas) {
                console.error('Canvas de firma no encontrado');
                return;
            }

            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Event listeners para mouse
            canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
            canvas.addEventListener('mousemove', (e) => this.draw(e));
            canvas.addEventListener('mouseup', () => this.stopDrawing());
            canvas.addEventListener('mouseleave', () => this.stopDrawing());

            // Event listeners para touch (pantallas táctiles)
            canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
            canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
            canvas.addEventListener('touchend', () => this.stopDrawing());
            canvas.addEventListener('touchcancel', () => this.stopDrawing());

            console.log('✓ Canvas de firma inicializado');
        }

        getMousePos(canvas, evt) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: evt.clientX - rect.left,
                y: evt.clientY - rect.top
            };
        }

        getTouchPos(canvas, touch) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: touch.clientX - rect.left,
                y: touch.clientY - rect.top
            };
        }

        startDrawing(e) {
            this.isDrawing = true;
            const canvas = document.getElementById('sacs-signature-canvas');
            const pos = this.getMousePos(canvas, e);
            this.lastX = pos.x;
            this.lastY = pos.y;
        }

        draw(e) {
            if (!this.isDrawing) return;

            const canvas = document.getElementById('sacs-signature-canvas');
            const ctx = canvas.getContext('2d');
            const pos = this.getMousePos(canvas, e);

            ctx.beginPath();
            ctx.moveTo(this.lastX, this.lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();

            this.lastX = pos.x;
            this.lastY = pos.y;

            // Marcar que se ha dibujado algo
            if (!this.firmaDibujada) {
                this.firmaDibujada = true;
                const btnConfirmar = document.getElementById('sacs-confirmar-firma-btn');
                if (btnConfirmar) btnConfirmar.disabled = false;

                const placeholder = document.getElementById('sacs-canvas-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            }
        }

        stopDrawing() {
            this.isDrawing = false;
        }

        handleTouchStart(e) {
            e.preventDefault();
            const canvas = document.getElementById('sacs-signature-canvas');
            const touch = e.touches[0];
            const pos = this.getTouchPos(canvas, touch);
            this.isDrawing = true;
            this.lastX = pos.x;
            this.lastY = pos.y;
        }

        handleTouchMove(e) {
            if (!this.isDrawing) return;
            e.preventDefault();

            const canvas = document.getElementById('sacs-signature-canvas');
            const ctx = canvas.getContext('2d');
            const touch = e.touches[0];
            const pos = this.getTouchPos(canvas, touch);

            ctx.beginPath();
            ctx.moveTo(this.lastX, this.lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();

            this.lastX = pos.x;
            this.lastY = pos.y;

            // Marcar que se ha dibujado algo
            if (!this.firmaDibujada) {
                this.firmaDibujada = true;
                const btnConfirmar = document.getElementById('sacs-confirmar-firma-btn');
                if (btnConfirmar) btnConfirmar.disabled = false;

                const placeholder = document.getElementById('sacs-canvas-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            }
        }

        limpiarFirma() {
            const canvas = document.getElementById('sacs-signature-canvas');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            this.firmaDibujada = false;
            this.firmaBase64 = null;

            const btnConfirmar = document.getElementById('sacs-confirmar-firma-btn');
            if (btnConfirmar) btnConfirmar.disabled = true;

            const placeholder = document.getElementById('sacs-canvas-placeholder');
            if (placeholder) placeholder.style.display = 'block';

            console.log('Firma limpiada');
        }

        async confirmarFirma() {
            if (!this.firmaDibujada) {
                console.error('No hay firma dibujada');
                return;
            }

            // Convertir canvas a base64
            const canvas = document.getElementById('sacs-signature-canvas');
            this.firmaBase64 = canvas.toDataURL('image/png');

            console.log('✓ Firma capturada:', this.firmaBase64.substring(0, 50) + '...');

            // Ir al paso 4 (Pago)
            this.goToStep(4);
        }

        volverDesdePago() {
            const requiereFirma = this.requiereFirma();

            if (requiereFirma) {
                // Si tiene firma, volver al paso 3 (firma)
                this.goToStep(3);
            } else {
                // Si NO tiene firma, volver al paso 2 (info cliente)
                this.goToStep(2);
            }
        }

        async processPaymentWithSignature() {
            try {
                console.log('Creando pedido con firma...');

                // Crear pedido CON firma
                await this.createOrder(
                    this.paymentIntentId,
                    'succeeded',
                    this.paymentTotal,
                    this.firmaBase64  // ← Firma capturada
                );

                // Ir a confirmación (paso 5)
                this.currentStep = 5;
                this.render();

            } catch (error) {
                console.error('Error creando pedido con firma:', error);
                this.showError('Error al guardar la firma. Por favor intente nuevamente.');
            }
        }

        // ==================== FIN MÉTODOS DEL CANVAS DE FIRMA ====================

        async processPayment() {
            const btnText = document.getElementById('sacs-btn-text');
            const btnSpinner = document.getElementById('sacs-btn-spinner');
            const payBtn = document.getElementById('sacs-pay-btn');
            const errorContainer = document.getElementById('sacs-error-container');

            // Validar que la info del cliente ya esté capturada (desde paso 2)
            if (!this.validateCustomerInfo()) {
                this.showError('Error: Información del cliente no encontrada');
                return;
            }

            // Mostrar spinner
            payBtn.disabled = true;
            btnText.style.display = 'none';
            btnSpinner.style.display = 'block';
            errorContainer.innerHTML = '';

            try {
                const total = this.calculateTotal();

                // 1. Crear Payment Intent
                const productsSimplified = this.cart.map(item => ({
                    nombre: item.nombre,
                    cantidad: item.quantity,
                    precio: item.precio
                }));

                const response = await fetch(`${SACS_API_URL}/stripe/${this.config.accountId}/create-payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        amount: Math.round(total * 100),
                        currency: 'mxn',
                        description: 'Compra en tienda online',
                        metadata: {
                            customer_name: this.customerInfo.nombre,
                            customer_email: this.customerInfo.correo,
                            products: JSON.stringify(productsSimplified)
                        }
                    })
                });

                const paymentData = await response.json();

                if (!response.ok || !paymentData.success) {
                    throw new Error(paymentData.error || 'Error al crear el pago');
                }

                // 2. Confirmar pago con Stripe
                const { error, paymentIntent } = await this.stripe.confirmCardPayment(
                    paymentData.clientSecret,
                    {
                        payment_method: {
                            card: this.cardElement,
                            billing_details: {
                                name: this.customerInfo.nombre,
                                email: this.customerInfo.correo,
                                address: {
                                    line1: this.customerInfo.direccion,
                                    city: this.customerInfo.ciudad,
                                    postal_code: this.customerInfo.codigoPostal
                                }
                            }
                        }
                    }
                );

                if (error) {
                    throw new Error(error.message);
                }

                // 3. Guardar order ID
                this.orderId = paymentIntent.id.substring(3).toUpperCase();

                // 4. Crear pedido con o sin firma
                if (this.firmaBase64) {
                    // CON FIRMA: Ya capturada en paso 3
                    console.log('✓ Pago exitoso - Crear pedido CON firma');
                    await this.createOrder(paymentIntent.id, 'succeeded', total, this.firmaBase64);
                } else {
                    // SIN FIRMA
                    console.log('✓ Pago exitoso - Crear pedido SIN firma');
                    await this.createOrder(paymentIntent.id, 'succeeded', total, null);
                }

                // 5. Ir a confirmación (paso 5)
                this.currentStep = 5;
                this.render();

            } catch (error) {
                console.error('Error en el pago:', error);
                this.showError(error.message || 'Ocurrió un error al procesar el pago');

                payBtn.disabled = false;
                btnText.style.display = 'block';
                btnSpinner.style.display = 'none';
            }
        }

        async createOrder(paymentIntentId, paymentStatus, total, firmaBase64 = null) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const now = Date.now();
                const fecha = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
                const hora = new Date().toTimeString().split(' ')[0]; // HH:MM:SS

                // Calcular subtotal sin IVA (16%)
                const subtotal = total / 1.16;
                const impuestosTotal = total - subtotal;

                // Validar que existan los account defaults
                if (!this.config.accountDefaults) {
                    throw new Error('No se encontró la configuración de la cuenta (accountDefaults)');
                }

                const defaults = this.config.accountDefaults;

                if (!defaults.almacen?.key) {
                    throw new Error('No se encontró el almacén en accountDefaults');
                }

                if (!defaults.sucursal?.key) {
                    throw new Error('No se encontró la sucursal en accountDefaults');
                }

                if (!defaults.tipoCliente?.key) {
                    throw new Error('No se encontró el tipo de cliente en accountDefaults');
                }

                // Construir header del pedido
                const header = {
                    fecha: fecha,
                    hora: hora,
                    tipo_cambio: 0,
                    tipo_cambio_dia: 0,
                    descuento: 0,
                    descuento_porcentaje_nota: 0,
                    descuento_importe_nota: 0,
                    descuentoImporteConImpuestos: 0,
                    descuento_razon: "",
                    tipo_descuento: "importe",
                    subtotal: subtotal,
                    tipo_de_envio: "gratis",
                    envio_tarifa_nombre: "",
                    envio_tarifa_importe: 0,
                    total: total,
                    totalImpuestos: total,
                    almacen: defaults.almacen.key,
                    almacennombre: defaults.almacen.name,
                    sucursal: defaults.sucursal.key,
                    sucursalnombre: defaults.sucursal.name,
                    cliente: null,
                    clientenombre: this.customerInfo.nombre,
                    clientetelefono: this.customerInfo.telefono || "",
                    clientecorreo: this.customerInfo.correo,
                    clientecalle: this.customerInfo.direccion || "",
                    clienteexterior: "",
                    clienteinterior: "",
                    clientecodigo: this.customerInfo.codigoPostal || "",
                    clientereferencia: "",
                    clientecolonia: "",
                    clientemunicipio: this.customerInfo.ciudad || "",
                    clienteestado: "",
                    clientepais: "México",
                    clientetipo: defaults.tipoCliente.key,
                    moneda: "-L21_TTrh_MTKO07LXSp",
                    moneda_nomenclatura: "MXN",
                    moneda_default: "-L21_TTrh_MTKO07LXSp",
                    moneda_prefijo: "$",
                    status: "Abierto",
                    statusPago: paymentStatus === 'succeeded' ? "Pagado" : "Pendiente",
                    statusPreparado: "No preparado",
                    canal: "Online - eCommerce Widget",
                    articulos: `${this.cart.length} articulos`,
                    uid: "-OUjfwh092oLaxFt0_T1",
                    username: "Widget eCommerce",
                    delivery_method: 'pickup',
                    comentarios: "Pedido realizado a través del widget embebido de eCommerce",
                    metodo_pago: 'stripe',
                    stripe_payment_intent_id: paymentIntentId,
                    stripe_payment_status: paymentStatus
                };

                // Construir details del pedido usando los productos completos de MongoDB
                const details = this.cart.map(item => {
                    const cantidad = Number(item.quantity);
                    const precioUnitario = Number(item.precio);
                    const costoUnitario = Number(item.costo);
                    const valorImpuesto = Number(item.valorimpuesto) / 100; // Convertir porcentaje a decimal

                    // Cálculos financieros (igual que fashion-forward)
                    const precioSinImpuesto = precioUnitario / (1 + valorImpuesto);
                    const importeSinImpuesto = precioSinImpuesto * cantidad;
                    const impuestoImporte = importeSinImpuesto * valorImpuesto;
                    const importeConImpuesto = importeSinImpuesto + impuestoImporte;

                    // Usar TODO el producto tal como viene de MongoDB
                    return {
                        // CAMPOS OBLIGATORIOS
                        id_producto: item.fid,
                        costo: costoUnitario,
                        cantidad: cantidad,
                        tipo: item.tipo,
                        fid: item.fid,

                        // CAMPOS DEL ARTÍCULO COMPLETO (usar los campos originales)
                        code: item.code || "",
                        nombre: item.nombre,
                        sku: item.sku || "",
                        precio: precioSinImpuesto, // SIN impuestos
                        precio_original: Number(item.precio_original || item.precio),
                        precio_carrito: Number(item.precio_carrito || item.precio),

                        // RELACIONES (usar los campos originales del producto)
                        proveedor: item.proveedor || "",
                        nombreproveedor: item.nombreproveedor || "",
                        categoria: item.categoria || "",
                        nombrecategoria: item.nombrecategoria || "",
                        marca: item.marca || "",
                        nombremarca: item.nombremarca || "",
                        unidad: item.unidad,
                        unidadclave: item.unidadclave,
                        unidadnombre: item.unidadnombre,

                        // MONEDA E IMPUESTOS (usar los campos originales)
                        moneda: item.moneda,
                        nombremoneda: item.nombremoneda || "MXN",
                        moneda_original: item.moneda_original || item.moneda,
                        impuestos: item.impuestos,
                        nombreimpuestos: item.nombreimpuestos,
                        valorimpuesto: Number(item.valorimpuesto),

                        // CÁLCULOS FINANCIEROS
                        importe: importeSinImpuesto,
                        importe_con_impuestos: importeConImpuesto,
                        impuesto_importe: impuestoImporte,
                        total_impuesto: impuestoImporte,

                        // OTROS CAMPOS
                        variante: item.variant || "",
                        descuento_importe: 0,
                        descuento_porcentaje: 0,
                        uid: "-OUjfwh092oLaxFt0_T1"
                    };
                });

                // Construir array de cobros (solo si es pago con Stripe exitoso)
                const cobros = [];

                if (paymentStatus === 'succeeded') {
                    cobros.push({
                        account: this.config.accountId,
                        metodo: 'Stripe',
                        importe: total,
                        moneda: header.moneda,
                        tipo_cambio: 1,
                        fecha: fecha,
                        hora: hora,
                        created: now,
                        modified: now,
                        datetime: now,
                        timestamp: now,
                        // Campos adicionales de Stripe
                        stripe_payment_intent_id: paymentIntentId,
                        stripe_payment_status: paymentStatus,
                        // Campos de lealtad (se inicializan en 0, el backend los procesará)
                        lealtad_puntos_anteriores: 0,
                        lealtad_puntos_generados: 0,
                        lealtad_puntos_consumidos: 0,
                        lealtad_puntos_actuales: 0,
                        lealtad_puntos_fijos_anteriores: 0,
                        lealtad_puntos_fijos_generados: 0,
                        lealtad_puntos_fijos_consumidos: 0,
                        lealtad_puntos_fijos_actuales: 0
                    });
                }

                // Crear el pedido
                const pedidoObject = {
                    account: this.config.accountId,
                    header: header,
                    details: details,
                    cobros: cobros
                };

                // 🔥 AGREGAR FIRMA SI EXISTE 🔥
                if (firmaBase64) {
                    pedidoObject.firmaBase64 = firmaBase64;
                    console.log('📦 Creando pedido en SACS CON FIRMA:', {
                        ...pedidoObject,
                        firmaBase64: firmaBase64.substring(0, 50) + '...'
                    });
                } else {
                    console.log('📦 Creando pedido en SACS (sin firma):', pedidoObject);
                }

                const response = await fetch(`${API_URL}/pedidos/createPedido`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(pedidoObject)
                });

                if (!response.ok) {
                    throw new Error(`Error ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();

                if (result.success) {
                    console.log('✓ Pedido creado exitosamente:', result.data);
                    // Actualizar el orderId con el folio real del pedido
                    if (result.data && result.data.folio) {
                        this.orderId = result.data.folio.toString();
                    }
                } else {
                    console.error('Error al crear pedido:', result.message);
                }

            } catch (error) {
                console.error('Error creando pedido:', error);
                // No interrumpir el flujo aunque falle la creación del pedido
            }
        }

        validateCustomerInfo() {
            return this.customerInfo.correo &&
                   this.customerInfo.nombre &&
                   this.customerInfo.direccion &&
                   this.customerInfo.ciudad &&
                   this.customerInfo.codigoPostal;
        }

        showError(message) {
            const errorContainer = document.getElementById('sacs-error-container');
            if (errorContainer) {
                errorContainer.innerHTML = `<div class="sacs-error-message">${message}</div>`;
            }
        }
    }

    // Exponer API global con soporte para múltiples instancias
    window.sacsCheckout = {
        instances: [],

        async init(options) {
            const instance = new SacsCheckout();
            await instance.init(options);
            this.instances.push(instance);
            return instance;
        }
    };

})(window);
