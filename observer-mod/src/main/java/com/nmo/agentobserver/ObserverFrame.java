package com.nmo.agentobserver;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

record ObserverFrame(String username, String connection, String action, double health, int food, Long experienceLevel,
                     int freeSlots, boolean foodRecovery, boolean shieldRaised, boolean modelEnabled,
                     String modelAction, String reason, String mineOrder, String mineResult, Point position,
                     Point target, Point mineTarget, Point committedTarget, Point actual, List<Point> waypoints,
                     boolean positionCentered, List<Point> trace, String routeSource, Long sampledAt, boolean inventoryFresh,
                     long totalTokens, Long inputTokens, Long outputTokens, Inventory inventory) {
    record Point(double x, Double y, double z, String name) {
        String coordinates() {
            return (int) Math.floor(x) + " / " + (y == null ? "?" : (int) Math.floor(y)) + " / " + (int) Math.floor(z);
        }
    }

    record Slot(String id, int count, int damage, boolean enchanted) {
        static final Slot EMPTY = new Slot("", 0, 0, false);
    }

    record Inventory(List<Slot> backpack, List<Slot> hotbar, List<Slot> armor, Slot offhand, int selected) {}

    static ObserverFrame disconnected(String message) {
        return disconnected("NMO-TestAgent", message);
    }

    static ObserverFrame disconnected(String username, String message) {
        return new ObserverFrame(username, message, "", 0, 0, null, 0, false, false, false, "", "",
            "", "", null, null, null, null, null, List.of(), false, List.of(), "", null, false, 0, null, null, null);
    }

    static ObserverFrame read(JsonObject state) {
        String username = text(state, "username");
        if (!flag(state, "connected")) return disconnected(username.isEmpty() ? "NMO-TestAgent" : username, "未连接");
        JsonObject navigation = object(state.get("navigation"));
        Point position = point(state.get("position"));
        boolean centered = state.has("positionCentered") ? flag(state, "positionCentered") : position != null &&
            (Math.floor(position.x()) != position.x() || Math.floor(position.z()) != position.z());
        JsonObject slots = object(state.get("inventory"));
        Inventory inventory = new Inventory(slots(slots.get("backpack"), 27), slots(slots.get("hotbar"), 9),
            slots(slots.get("armor"), 4), slot(slots.get("offhand")), (int) number(slots, "selected", -1));
        JsonObject tokens = object(state.get("tokens"));
        String combatReason = text(state, "combatReason");
        return new ObserverFrame(username, "在线", text(state, "action"), number(state, "health", 0),
            (int) number(state, "food", 0), optionalCount(state, "experienceLevel"), (int) number(state, "freeSlots", 0),
            flag(state, "foodRecovery"),
            flag(state, "shieldRaised"), flag(state, "modelEnabled"), text(state, "modelAction"),
            combatReason.isEmpty() ? text(state, "modelReason") : combatReason, text(state, "mineOrder"),
            text(state, "mineResult"), position, point(navigation.get("target")),
            point(state.get("mineTarget")), point(state.get("committedMineTarget")), point(state.get("actual")),
            routePoints(navigation.get("waypoints")), centered, routePoints(navigation.get("trace")),
            text(navigation, "routeSource"), optionalCount(state, "sampledAt"),
            !state.has("inventoryFresh") || flag(state, "inventoryFresh"),
            (long) number(tokens, "total", 0), optionalCount(tokens, "input"),
            optionalCount(tokens, "output"), inventory);
    }

    private static List<Point> routePoints(JsonElement points) {
        List<Point> result = new ArrayList<>();
        if (points != null && points.isJsonArray()) {
            for (JsonElement element : points.getAsJsonArray()) {
                Point point = point(element);
                if (point != null && point.y != null) result.add(point);
            }
        }
        return List.copyOf(result);
    }

    private static JsonObject object(JsonElement element) {
        return element != null && element.isJsonObject() ? element.getAsJsonObject() : new JsonObject();
    }

    private static String text(JsonObject object, String name) {
        var value = object.get(name);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : "";
    }

    private static boolean flag(JsonObject object, String name) {
        var value = object.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsBoolean();
    }

    private static double number(JsonObject object, String name, double fallback) {
        var value = object.get(name);
        return value != null && value.isJsonPrimitive() ? value.getAsDouble() : fallback;
    }

    private static Long optionalCount(JsonObject object, String name) {
        var value = object.get(name);
        return value != null && value.isJsonPrimitive() ? value.getAsLong() : null;
    }

    private static Point point(JsonElement element) {
        JsonObject json = object(element);
        double x = number(json, "x", Double.NaN), z = number(json, "z", Double.NaN);
        double y = number(json, "y", Double.NaN);
        return Double.isFinite(x) && Double.isFinite(z)
            ? new Point(x, Double.isFinite(y) ? y : null, z, text(json, "name")) : null;
    }

    private static Slot slot(JsonElement element) {
        JsonObject json = object(element);
        String id = text(json, "id");
        int count = (int) number(json, "count", 0);
        return id.isEmpty() || count <= 0 ? Slot.EMPTY : new Slot(id, count,
            (int) number(json, "damage", 0), flag(json, "enchanted"));
    }

    private static List<Slot> slots(JsonElement source, int length) {
        List<Slot> result = new ArrayList<>(length);
        var array = source != null && source.isJsonArray() ? source.getAsJsonArray() : null;
        for (int i = 0; i < length; i++) result.add(array != null && i < array.size() ? slot(array.get(i)) : Slot.EMPTY);
        return List.copyOf(result);
    }
}
