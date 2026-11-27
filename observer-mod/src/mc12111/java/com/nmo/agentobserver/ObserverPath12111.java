package com.nmo.agentobserver;

import com.mojang.blaze3d.pipeline.RenderPipeline;
import com.mojang.blaze3d.platform.DepthTestFunction;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import net.fabricmc.fabric.api.client.rendering.v1.world.WorldRenderContext;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.rendertype.RenderSetup;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.resources.Identifier;
import net.minecraft.world.phys.Vec3;

final class ObserverPath12111 implements AutoCloseable {
    private static final int RED = 0xFFFF3030;
    private static final int TRACE = 0xFF3DBFC5;
    private static final int MINE = 0xFFA3F6AE;
    private static final float WIDTH = 4.0F;
    private static final RenderPipeline PIPELINE = RenderPipelines.register(
        RenderPipeline.builder(RenderPipelines.LINES_SNIPPET)
            .withLocation(Identifier.fromNamespaceAndPath("nmo-agent-observer", "pipeline/route"))
            .withDepthTestFunction(DepthTestFunction.NO_DEPTH_TEST)
            .withDepthWrite(false)
            .build());
    private static final RenderType ROUTE = RenderType.create("nmo_observer_route",
        RenderSetup.builder(PIPELINE).createRenderSetup());
    private final ByteBufferBuilder vertices = new ByteBufferBuilder(4096);
    private final MultiBufferSource.BufferSource buffers = MultiBufferSource.immediate(vertices);

    void render(WorldRenderContext context) {
        ObserverTelemetry.Snapshot snapshot = ObserverTelemetry.snapshot();
        ObserverFrame frame = snapshot.frame();
        ObserverFrame.Point position = frame.position();
        ObserverFrame.Point target = frame.target();
        ObserverFrame.Point mine = frame.mineTarget();
        if (snapshot.delayed()) return;
        boolean drawTrace = frame.waypoints().isEmpty() && frame.trace().size() > 1;
        if (position == null || position.y() == null || (frame.waypoints().isEmpty() && target == null && mine == null && !drawTrace)) return;
        PoseStack matrices = context.matrices();
        Vec3 camera = context.worldState().cameraRenderState.pos;
        matrices.pushPose();
        try {
            matrices.translate(-camera.x, -camera.y, -camera.z);
            PoseStack.Pose pose = matrices.last();
            VertexConsumer lines = buffers.getBuffer(ROUTE);
            double offset = frame.positionCentered() ? 0 : 0.5;
            Vec3 previous = new Vec3(position.x() + offset, position.y() + 0.15, position.z() + offset);
            for (ObserverFrame.Point point : frame.waypoints()) {
                Vec3 next = routePoint(point);
                line(pose, lines, previous, next, RED);
                previous = next;
            }
            if (drawTrace) {
                Vec3 observed = routePoint(frame.trace().getFirst());
                for (ObserverFrame.Point point : frame.trace().subList(1, frame.trace().size())) {
                    Vec3 next = routePoint(point);
                    line(pose, lines, observed, next, TRACE);
                    observed = next;
                }
            }
            Vec3 mineBox = mine == null ? null : blockOrigin(mine, previous.y);
            if (target != null) {
                Vec3 goalBox = blockOrigin(target, previous.y);
                if (!goalBox.equals(mineBox)) box(pose, lines, goalBox, RED);
            }
            if (mineBox != null) box(pose, lines, mineBox, MINE);
            buffers.endBatch(ROUTE);
        } finally {
            matrices.popPose();
        }
    }

    private static Vec3 routePoint(ObserverFrame.Point point) {
        return new Vec3(point.x(), point.y() + 0.15, point.z());
    }

    private static Vec3 blockOrigin(ObserverFrame.Point point, double fallbackY) {
        return new Vec3(Math.floor(point.x()), Math.floor(point.y() == null ? fallbackY : point.y()), Math.floor(point.z()));
    }

    private static void box(PoseStack.Pose pose, VertexConsumer lines, Vec3 origin, int color) {
        for (int corner = 0; corner < 8; corner++) {
            Vec3 point = origin.add(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
            if ((corner & 1) == 0) line(pose, lines, point, point.add(1, 0, 0), color);
            if ((corner & 2) == 0) line(pose, lines, point, point.add(0, 1, 0), color);
            if ((corner & 4) == 0) line(pose, lines, point, point.add(0, 0, 1), color);
        }
    }

    private static void line(PoseStack.Pose pose, VertexConsumer lines, Vec3 from, Vec3 to, int color) {
        line(pose, lines, from, to, color, WIDTH);
    }

    static void line(PoseStack.Pose pose, VertexConsumer lines, Vec3 from, Vec3 to, int color, float width) {
        Vec3 delta = to.subtract(from);
        if (delta.lengthSqr() < 1e-8) return;
        Vec3 direction = delta.normalize();
        vertex(pose, lines, from, direction, color, width);
        vertex(pose, lines, to, direction, color, width);
    }

    private static void vertex(PoseStack.Pose pose, VertexConsumer lines, Vec3 point, Vec3 direction, int color, float width) {
        lines.addVertex(pose, (float) point.x, (float) point.y, (float) point.z)
            .setColor(color).setNormal(pose, (float) direction.x, (float) direction.y, (float) direction.z)
            .setLineWidth(width);
    }

    @Override
    public void close() {
        vertices.close();
    }
}
