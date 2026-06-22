// The 'test_foo___bar' test program.
import foo___bar.aleo;
program test_foo___bar.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = foo___bar.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
