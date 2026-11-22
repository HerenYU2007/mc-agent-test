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
        ObserverFrame frame = ObserverTelemetry.frame();
        ObserverFrame.Point position = frame.position();
        ObserverFrame.Point target = frame.mineTarget() == null ? frame.target() : frame.mineTarget();
        if (position == null || position.y() == null || (frame.waypoints().isEmpty() && target == null)) return;
        PoseStack matrices = context.matrices();
        Vec3 camera = context.worldState().cameraRenderState.pos;
        matrices.pushPose();
        try {
            matrices.translate(-camera.x, -camera.y, -camera.z);
            PoseStack.Pose pose = matrices.last();
            VertexConsumer lines = buffers.getBuffer(ROUTE);
            Vec3 previous = new Vec3(position.x() + 0.5, position.y() + 0.15, position.z() + 0.5);
            for (ObserverFrame.Point point : frame.waypoints()) {
                Vec3 next = new Vec3(point.x(), point.y() + 0.15, point.z());
                line(pose, lines, previous, next);
                previous = next;
            }
            if (target != null) {
                double y = target.y() == null ? Math.floor(previous.y) : target.y();
                box(pose, lines, new Vec3(target.x(), y, target.z()));
            }
            buffers.endBatch(ROUTE);
        } finally {
            matrices.popPose();
        }
    }

    private static void box(PoseStack.Pose pose, VertexConsumer lines, Vec3 origin) {
        for (int corner = 0; corner < 8; corner++) {
            Vec3 point = origin.add(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
            if ((corner & 1) == 0) line(pose, lines, point, point.add(1, 0, 0));
            if ((corner & 2) == 0) line(pose, lines, point, point.add(0, 1, 0));
            if ((corner & 4) == 0) line(pose, lines, point, point.add(0, 0, 1));
        }
    }

    private static void line(PoseStack.Pose pose, VertexConsumer lines, Vec3 from, Vec3 to) {
        Vec3 delta = to.subtract(from);
        if (delta.lengthSqr() < 1e-8) return;
        Vec3 direction = delta.normalize();
        vertex(pose, lines, from, direction);
        vertex(pose, lines, to, direction);
    }

    private static void vertex(PoseStack.Pose pose, VertexConsumer lines, Vec3 point, Vec3 direction) {
        lines.addVertex(pose, (float) point.x, (float) point.y, (float) point.z)
            .setColor(RED).setNormal(pose, (float) direction.x, (float) direction.y, (float) direction.z)
            .setLineWidth(WIDTH);
    }

    @Override
    public void close() {
        vertices.close();
    }
}
