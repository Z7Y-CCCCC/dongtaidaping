export function getWidgetsByType(platform, type) {
    return (platform?.widgets || []).filter(widget =>
        widget.widget_type === type &&
        widget.visible !== 0 &&
        widget.visible !== false
    );
}

export function getFirstWidget(platform, type, fallback = null) {
    return getWidgetsByType(platform, type)[0] || fallback;
}

export function getSceneTheme(platform) {
    return platform?.activeScene?.theme || { preset: 'industrial_twin' };
}

export function getSceneCamera(platform) {
    return platform?.activeScene?.camera || { mode: 'auto', staleMs: 6000 };
}

export function getWidgetConfig(widget, fallback = {}) {
    return widget?.config || fallback;
}
