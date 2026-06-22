// The 'test_reach' test program.
import reach.aleo;
program test_reach.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = reach.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
