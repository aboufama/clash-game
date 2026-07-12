/**
 * Mobile detection and utility functions
 */

export class MobileUtils {
    private static _isMobile: boolean | null = null;
    private static _isTouchDevice: boolean | null = null;

    /**
     * Detect if the device is mobile based on screen size and user agent
     */
    static isMobile(): boolean {
        if (this._isMobile !== null) return this._isMobile;

        const userAgent = navigator.userAgent.toLowerCase();
        const mobileKeywords = ['android', 'webos', 'iphone', 'ipad', 'ipod', 'blackberry', 'windows phone'];
        const isMobileUserAgent = mobileKeywords.some(keyword => userAgent.includes(keyword));

        // Also check screen size - consider tablets as mobile for UI purposes
        const isSmallScreen = window.innerWidth <= 1024;

        this._isMobile = isMobileUserAgent || isSmallScreen;
        return this._isMobile;
    }

    /**
     * Detect if the device supports touch
     */
    static isTouchDevice(): boolean {
        if (this._isTouchDevice !== null) return this._isTouchDevice;

        this._isTouchDevice = (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            (navigator as any).msMaxTouchPoints > 0
        );
        return this._isTouchDevice;
    }

    /**
     * Get optimal zoom level for mobile
     */
    static getDefaultZoom(): number {
        if (this.isMobile()) {
            // Zoom out more on mobile for better overview
            const screenSize = Math.min(window.innerWidth, window.innerHeight);
            if (screenSize < 400) return 0.6;
            if (screenSize < 600) return 0.7;
            return 0.8;
        }
        return 1.0;
    }

    /**
     * Absolute zoom floor. Gestures normally stop earlier, at the scene's
     * dynamic village-and-clouds fit (MainScene.minGestureZoom); this is the
     * safety bound that fit is clamped against.
     */
    static getMinZoom(): number {
        return this.isMobile() ? 0.12 : 0.15;
    }

    /**
     * Get maximum zoom for pinch gesture
     */
    static getMaxZoom(): number {
        return this.isMobile() ? 2.0 : 3.0;
    }

    /**
     * Calculate distance between two touch points
     */
    static getTouchDistance(touch1: Touch, touch2: Touch): number {
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Calculate center point between two touches, relative to canvas
     */
    static getTouchCenter(touch1: Touch, touch2: Touch, canvas: HTMLCanvasElement): { x: number; y: number } {
        const rect = canvas.getBoundingClientRect();
        // Native TouchEvent coordinates are CSS pixels. Phaser Pointer and
        // camera viewport coordinates live in drawing-buffer pixels on a
        // high-DPI canvas, so cross the boundary exactly once here.
        const scaleX = canvas.width / Math.max(1, rect.width);
        const scaleY = canvas.height / Math.max(1, rect.height);
        return {
            x: (((touch1.clientX + touch2.clientX) / 2) - rect.left) * scaleX,
            y: (((touch1.clientY + touch2.clientY) / 2) - rect.top) * scaleY
        };
    }

    /**
     * Reset cached values (useful when orientation changes)
     */
    static reset(): void {
        this._isMobile = null;
        this._isTouchDevice = null;
    }

    /**
     * Prevent default touch behaviors that interfere with game
     */
    static preventDefaultTouchBehaviors(): void {
        // Prevent pull-to-refresh and overscroll
        document.body.style.overscrollBehavior = 'none';

        // Prevent double-tap zoom but allow touch events
        document.body.style.touchAction = 'none';

        // Prevent context menu on long press
        document.addEventListener('contextmenu', (e) => {
            if (this.isTouchDevice()) {
                e.preventDefault();
            }
        });

        // Prevent Safari gesture events on the page (we handle pinch in-game via touch events)
        document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

        // Prevent touchmove default on document to stop page scrolling, but allow it on game canvas
        document.addEventListener('touchmove', (e) => {
            const target = e.target as HTMLElement;
            // Allow default behavior for UI elements (modals, scrollable areas)
            if (target.closest('.modal-body') || target.closest('.troop-grid') || target.closest('.building-grid')) {
                return;
            }
            e.preventDefault();
        }, { passive: false });
    }

    /**
     * Setup viewport for mobile
     */
    static setupMobileViewport(): void {
        // Ensure viewport meta exists and is properly configured
        let viewport = document.querySelector('meta[name="viewport"]');
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.setAttribute('name', 'viewport');
            document.head.appendChild(viewport);
        }
        viewport.setAttribute('content',
            'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
        );

        // Add mobile class to body for CSS targeting
        if (this.isMobile()) {
            document.body.classList.add('is-mobile');
        }
        if (this.isTouchDevice()) {
            document.body.classList.add('is-touch');
        }
    }
}
