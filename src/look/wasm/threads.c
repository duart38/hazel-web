/* dispatch_apply_f over WebAssembly threads, for look-threads.wasm. Every thread is an instance of
 * the same module on one shared memory: the caller (the look worker) and the helpers, each a
 * Worker that sets its own stack and then sits in hz_helper_main for good. A job's iterations
 * are handed out one at a time; whoever is free takes the next, the caller included, so a job
 * finishes even with no helpers at all. look.c's bands never read what another band writes, so
 * the picture is the same whichever thread runs which band. */
#include <stddef.h>
#include <stdint.h>
#include <dispatch/dispatch.h>

/* `claim` holds the job's generation in its top 32 bits and the next unclaimed iteration in the
 * low 32, so a helper still holding the previous job's generation can never take an iteration
 * of the next job: its compare-and-swap fails. The job's fields aren't rewritten until every
 * iteration of it is done, which can't happen while a claimed one is still running. */
static struct {
    _Atomic uint64_t claim;
    _Atomic uint32_t generation;  /* helpers wait on this */
    _Atomic uint32_t done;        /* the caller waits on this */
    _Atomic uint32_t running;     /* a job is under way: a nested call runs serially */
    uint32_t count;
    void *context;
    void (*work)(void *, size_t);
} job;

static void run_iterations(uint32_t generation) {
    for (;;) {
        uint64_t claim = __c11_atomic_load(&job.claim, __ATOMIC_SEQ_CST);
        if ((uint32_t)(claim >> 32) != generation) return;
        uint32_t index = (uint32_t)claim, count = job.count;
        if (index >= count) return;
        void (*work)(void *, size_t) = job.work;
        void *context = job.context;
        if (!__c11_atomic_compare_exchange_weak(&job.claim, &claim, claim + 1, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST))
            continue;
        work(context, index);
        if (__c11_atomic_fetch_add(&job.done, 1, __ATOMIC_SEQ_CST) + 1 == count)
            __builtin_wasm_memory_atomic_notify((int *)&job.done, 1);
    }
}

void dispatch_apply_f(size_t iterations, dispatch_queue_t queue, void *context, void (*work)(void *, size_t)) {
    (void)queue;
    uint32_t idle = 0;
    if (iterations < 2 || !__c11_atomic_compare_exchange_strong(&job.running, &idle, 1, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)) {
        for (size_t i = 0; i < iterations; i++) work(context, i);
        return;
    }
    uint32_t count = (uint32_t)iterations;
    uint32_t generation = __c11_atomic_load(&job.generation, __ATOMIC_SEQ_CST) + 1;
    job.count = count;
    job.context = context;
    job.work = work;
    __c11_atomic_store(&job.done, 0, __ATOMIC_SEQ_CST);
    __c11_atomic_store(&job.claim, (uint64_t)generation << 32, __ATOMIC_SEQ_CST);
    __c11_atomic_store(&job.generation, generation, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int *)&job.generation, (unsigned)-1);
    run_iterations(generation);
    for (;;) {
        uint32_t done = __c11_atomic_load(&job.done, __ATOMIC_SEQ_CST);
        if (done >= count) break;
        __builtin_wasm_memory_atomic_wait32((int *)&job.done, (int)done, -1);
    }
    __c11_atomic_store(&job.running, 0, __ATOMIC_SEQ_CST);
}

/* A helper thread's whole life, after the JavaScript side has pointed its stack at its own
 * memory: wait for a job, help with it, wait again. Never returns; the Worker is terminated. */
void hz_helper_main(void) {
    uint32_t seen = __c11_atomic_load(&job.generation, __ATOMIC_SEQ_CST);
    for (;;) {
        uint32_t generation;
        while ((generation = __c11_atomic_load(&job.generation, __ATOMIC_SEQ_CST)) == seen)
            __builtin_wasm_memory_atomic_wait32((int *)&job.generation, (int)seen, -1);
        seen = generation;
        run_iterations(generation);
    }
}
