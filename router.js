
export class Router {
    constructor(routes) {
        this.routes = routes;
        this.rootElem = document.getElementById('app');
        this.currentHash = null;
        this.scrollPositions = new Map();
        window.addEventListener('hashchange', () => this.handleRoute());
        this.handleRoute(); 
    }

    handleRoute() {
        const hash = window.location.hash || '#/';
        if (this.currentHash && typeof window !== 'undefined') {
            this.scrollPositions.set(this.currentHash, window.scrollY || window.pageYOffset || 0);
        }

        const route = this.routes[hash] || this.routes[hash.split('?')[0]] || this.routes['404'] || this.routes['#/'];
        this.currentHash = hash;

        if (route) {
            try {
                const result = route();
                if (result && typeof result.then === 'function') {
                    result.then(() => this.afterNavigation(hash)).catch(err => {
                        console.error('Route error for', hash, err);
                    });
                } else {
                    this.afterNavigation(hash);
                }
            } catch (err) {
                console.error('Route execution failed for', hash, err);
            }
        } else {
            console.error('No route found for', hash);
        }
    }

    afterNavigation(hash) {
        // Restore scroll position or scroll to top
        if (typeof window !== 'undefined') {
            const savedScroll = this.scrollPositions.get(hash);
            if (typeof savedScroll === 'number') {
                window.scrollTo({ top: savedScroll, behavior: 'instant' });
            } else {
                window.scrollTo({ top: 0, behavior: 'instant' });
            }
        }

        // Move focus to page heading for accessibility
        if (this.rootElem) {
            const heading = this.rootElem.querySelector('h1, h2, .page-title, [role="heading"]');
            if (heading) {
                if (!heading.hasAttribute('tabindex')) {
                    heading.setAttribute('tabindex', '-1');
                }
                heading.focus({ preventScroll: true });
            }

            // Route announcement via aria-live
            const announcer = document.getElementById('route-announcer');
            if (announcer) {
                const headingText = heading ? (heading.textContent || '').trim().replace(/\s+/g, ' ') : '';
                const label = headingText || this.getRouteLabel(hash);
                announcer.textContent = `Navigated to ${label}`;
            }
        }
    }

    getRouteLabel(hash) {
        const clean = (hash || '').replace(/^#\/?/, '').split('?')[0];
        if (!clean) return 'Home';
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    }

    clearScrollPositions() {
        this.scrollPositions.clear();
    }

    navigate(hash) {
        window.location.hash = hash;
    }
}
