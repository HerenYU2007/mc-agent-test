#include <stdint.h>
#include "finders.h"

#define RESULT_LIMIT 5
#define WORLD_LIMIT 29999984

static Pos results[RESULT_LIMIT];

static int floor_div(int coordinate, int spacing)
{
    return coordinate / spacing - (coordinate % spacing < 0);
}

const Pos *village_coordinates(void)
{
    return results;
}

int find_villages(uint64_t seed, int base_x, int base_z, int radius)
{
    const int version = MC_1_21_11;
    Generator generator;
    StructureConfig config;
    setupGenerator(&generator, version, 0);
    applySeed(&generator, DIM_OVERWORLD, seed);
    if (!getStructureConfig(Village, version, &config))
        return 0;
    const int region_size = config.regionSize * 16;
    const int64_t radius_squared = (int64_t) radius * radius;
    int count = 0;
    int64_t distances[RESULT_LIMIT];

    for (int rx = floor_div(base_x - radius, region_size); rx <= floor_div(base_x + radius, region_size); ++rx) {
        for (int rz = floor_div(base_z - radius, region_size); rz <= floor_div(base_z + radius, region_size); ++rz) {
            Pos point;
            if (!getStructurePos(Village, version, seed, rx, rz, &point))
                continue;
            if (point.x < -WORLD_LIMIT || point.x > WORLD_LIMIT || point.z < -WORLD_LIMIT || point.z > WORLD_LIMIT)
                continue;
            const int64_t dx = point.x - base_x;
            const int64_t dz = point.z - base_z;
            const int64_t distance = dx * dx + dz * dz;
            if (distance > radius_squared || (count == RESULT_LIMIT && distance >= distances[count - 1]))
                continue;
            if (!isViableStructurePos(Village, &generator, point.x, point.z, 0))
                continue;

            if (count < RESULT_LIMIT)
                ++count;
            int index = count - 1;
            while (index > 0 && distance < distances[index - 1]) {
                distances[index] = distances[index - 1];
                results[index] = results[index - 1];
                --index;
            }
            distances[index] = distance;
            results[index] = point;
        }
    }
    return count;
}
