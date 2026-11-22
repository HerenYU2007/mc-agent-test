package com.nmo.agentobserver;

import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.gizmos.Gizmos;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class AgentObserverClient implements ClientModInitializer {
    private static int renderTick;

    @Override
    public void onInitializeClient() {
        ObserverTelemetry.start();
    }

    public static void renderPathLines(Minecraft minecraft) {
        ObserverFrame frame = ObserverTelemetry.frame();
        if (minecraft.level == null || (++renderTick % 2) != 0 || frame.position() == null) return;
        ObserverFrame.Point position = frame.position();
        if (position.y() == null) return;

        try (Gizmos.TemporaryCollection ignored = minecraft.collectPerTickGizmos()) {
            Vec3 previous = new Vec3(position.x() + 0.5, position.y() + 0.15, position.z() + 0.5);
            for (ObserverFrame.Point point : frame.waypoints()) {
                Vec3 next = new Vec3(point.x(), point.y() + 0.15, point.z());
                Gizmos.line(previous, next, 0xFFFF3030, 4.0F).setAlwaysOnTop().persistForMillis(120);
                previous = next;
            }
            ObserverFrame.Point target = frame.mineTarget() == null ? frame.target() : frame.mineTarget();
            if (target == null) return;
            double y = target.y() == null ? Math.floor(previous.y) : target.y();
            Gizmos.cuboid(new AABB(target.x(), y, target.z(), target.x() + 1, y + 1, target.z() + 1),
                GizmoStyle.stroke(0xFFFF3030, 4.0F)).setAlwaysOnTop().persistForMillis(120);
        }
    }
}
